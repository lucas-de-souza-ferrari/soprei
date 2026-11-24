import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  PlatformSession,
  PlatformSessionStore,
} from '../application/ports/platform-session.js';
import {
  base32Encode,
  generateTotpSecret,
  totpCode,
  totpStep,
} from '../application/platform/totp.js';
import type {
  ListOptions,
  NewPlatformAuditEvent,
  Page,
  PlatformAdminId,
  PlatformAuditEvent,
  PlatformAuditRepository,
} from '../domain/index.js';
import {
  AesGcmPlatformSecretCipher,
  parseCredentialKeys,
} from '../infrastructure/security/aes-gcm-credential-cipher.js';
import { ServiceUnavailableError } from '../shared/errors/index.js';
import { SecretString } from '../shared/types/index.js';
import { type TestAuth, TEST_PASSWORD } from './in-memory-auth.js';

/** Chaves descartáveis do segredo TOTP (spec 044), no formato de `PLATFORM_TOTP_KEYS`. */
export const TEST_PLATFORM_TOTP_KEYS = `t1:${Buffer.alloc(32, 7).toString('base64url')}`;

export function testPlatformCipher(): AesGcmPlatformSecretCipher {
  const parsed = parseCredentialKeys(TEST_PLATFORM_TOTP_KEYS);
  if (!parsed.ok) throw new Error('chaves de teste inválidas');
  return new AesGcmPlatformSecretCipher(parsed.keys, 't1');
}

/** Relógio manual dos testes (milissegundos). */
export class ManualClock {
  constructor(public ms: number = Date.UTC(2026, 10, 24, 12, 0, 0)) {}
  now = (): number => this.ms;
  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

/** O código atual de um segredo, no relógio dado. */
export function codeAt(secret: Buffer, nowMs: number, stepOffset = 0): string {
  return totpCode(secret, totpStep(nowMs) + stepOffset);
}

export interface EnrolledAdmin {
  readonly email: string;
  readonly adminId: PlatformAdminId;
  readonly secret: Buffer;
}

/** Cria um administrador com a senha de teste e o segundo fator cadastrado (como faz a CLI). */
export async function enrollTestAdmin(
  auth: Pick<TestAuth, 'platformAdmins' | 'hasher'>,
  cipher: AesGcmPlatformSecretCipher,
  email = `p-${randomUUID()}@exemplo.test`,
): Promise<EnrolledAdmin> {
  const admin = await auth.platformAdmins.create({
    email,
    passwordHash: await auth.hasher.hash(TEST_PASSWORD),
  });
  const secret = generateTotpSecret();
  await auth.platformAdmins.setTotpSecret(
    admin.id,
    cipher.encrypt(admin.id, new SecretString(base32Encode(secret))),
  );
  return { email, adminId: admin.id, secret };
}

interface StoredSession {
  readonly session: PlatformSession;
  readonly expiresAtMs: number;
  idleUntilMs: number;
}

/** `PlatformSessionStore` em memória, com prazo ocioso e teto pelo relógio dado, e falha sob comando. */
export class InMemoryPlatformSessionStore implements PlatformSessionStore {
  readonly entries = new Map<string, StoredSession>();
  /** Liga para simular o Redis fora (toda operação vira 503). */
  failing = false;

  constructor(
    private readonly now: () => number,
    private readonly idleSeconds = 1_800,
    private readonly maxSeconds = 43_200,
  ) {}

  static hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private check(): void {
    if (this.failing) throw new ServiceUnavailableError('Sessão indisponível');
  }

  create(adminId: string, factor: string): Promise<string> {
    this.check();
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    this.entries.set(InMemoryPlatformSessionStore.hash(secret), {
      session: { id: randomUUID(), adminId, factor },
      expiresAtMs: now + this.maxSeconds * 1000,
      idleUntilMs: now + this.idleSeconds * 1000,
    });
    return Promise.resolve(secret);
  }

  read(secret: string): Promise<PlatformSession | null> {
    this.check();
    const key = InMemoryPlatformSessionStore.hash(secret);
    const stored = this.entries.get(key);
    if (stored === undefined) return Promise.resolve(null);
    const now = this.now();
    if (now >= stored.expiresAtMs || now >= stored.idleUntilMs) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    stored.idleUntilMs = Math.min(now + this.idleSeconds * 1000, stored.expiresAtMs);
    return Promise.resolve(stored.session);
  }

  revoke(secret: string): Promise<void> {
    this.check();
    this.entries.delete(InMemoryPlatformSessionStore.hash(secret));
    return Promise.resolve();
  }
}

/** Trilha da plataforma em memória: só `create` e `list`, como a real. */
export class InMemoryPlatformAuditRepository implements PlatformAuditRepository {
  readonly events: PlatformAuditEvent[] = [];

  create(data: NewPlatformAuditEvent): Promise<PlatformAuditEvent> {
    const event: PlatformAuditEvent = {
      id: randomUUID(),
      adminId: data.adminId,
      action: data.action,
      subjectCompanyId: data.subjectCompanyId ?? null,
      subjectAccountId: data.subjectAccountId ?? null,
      reason: data.reason ?? null,
      createdAt: new Date(),
    };
    this.events.push(event);
    return Promise.resolve(event);
  }

  list(options?: ListOptions): Promise<Page<PlatformAuditEvent>> {
    const limit = options?.limit ?? 30;
    return Promise.resolve({
      items: [...this.events].reverse().slice(0, limit),
      nextCursor: null,
    });
  }
}
