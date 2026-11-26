import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  PlatformAccountMembershipRef,
  PlatformAccountTransaction,
  PlatformAccountUnitOfWork,
  PlatformLockedAccount,
} from '../application/ports/platform-account-unit-of-work.js';
import type {
  PlatformCompanyTransaction,
  PlatformCompanyUnitOfWork,
  PlatformLockedMembership,
  PlatformRemovedChannel,
} from '../application/ports/platform-company-unit-of-work.js';
import type {
  PlatformOverviewFacts,
  PlatformReadModel,
} from '../application/ports/platform-read-model.js';
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
  AccessStatus,
  CompanyStatus,
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
import { NotFoundError, ServiceUnavailableError } from '../shared/errors/index.js';
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
      subjectMembershipId: data.subjectMembershipId ?? null,
      subjectInvitationId: data.subjectInvitationId ?? null,
      fromRole: data.fromRole ?? null,
      toRole: data.toRole ?? null,
      planCode: data.planCode ?? null,
      days: data.days ?? null,
      moduleSchedule: data.moduleSchedule ?? null,
      moduleInventory: data.moduleInventory ?? null,
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

/**
 * `PlatformCompanyUnitOfWork` em memória (spec 044, E2; spec 045, E3a): estado das empresas e dos vínculos
 * em mapas, trilha no repositório em memória e transações serializadas (como a trava da linha no
 * Postgres). Cada transação trabalha numa cópia e só grava no fim (como o commit): falha no meio não muda
 * nada. `failAudit` faz a gravação da trilha falhar; `activeOwnerCount` segue a regra comum 11.
 */
export class InMemoryPlatformCompanyUnitOfWork implements PlatformCompanyUnitOfWork {
  readonly statuses = new Map<string, CompanyStatus>();
  readonly names = new Map<string, string>();
  readonly slugs = new Map<string, string>();
  readonly removed = new Set<string>();
  readonly channels = new Map<string, PlatformRemovedChannel>();
  /** Chave `<companyId>:<membershipId>`. */
  readonly memberships = new Map<string, PlatformLockedMembership>();
  /** Empresas cujos convites pendentes foram revogados pela remoção. */
  readonly invitationsRevoked: string[] = [];
  failAudit = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly audit: InMemoryPlatformAuditRepository = new InMemoryPlatformAuditRepository(),
  ) {}

  /** Põe uma empresa no mundo (ativa, sem remoção). */
  addCompany(id: string, slug = 'empresa', name = 'Empresa'): void {
    this.statuses.set(id, 'ACTIVE');
    this.slugs.set(id, slug);
    this.names.set(id, name);
  }

  addMembership(
    companyId: string,
    membershipId: string,
    membership: PlatformLockedMembership,
  ): void {
    this.memberships.set(`${companyId}:${membershipId}`, membership);
  }

  membership(companyId: string, membershipId: string): PlatformLockedMembership | undefined {
    return this.memberships.get(`${companyId}:${membershipId}`);
  }

  run<T>(fn: (tx: PlatformCompanyTransaction) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const statuses = new Map(this.statuses);
      const names = new Map(this.names);
      const removed = new Set(this.removed);
      const channels = new Map(this.channels);
      const memberships = new Map(this.memberships);
      const revoked: string[] = [];
      const events: NewPlatformAuditEvent[] = [];
      const live = (companyId: string): CompanyStatus => {
        const status = statuses.get(companyId);
        if (status === undefined || removed.has(companyId)) {
          throw new NotFoundError('Empresa não encontrada');
        }
        return status;
      };
      const result = await fn({
        lockCompany: (companyId) => Promise.resolve().then(() => live(companyId)),
        company: (companyId) =>
          Promise.resolve().then(() => ({
            status: live(companyId),
            name: names.get(companyId) ?? '',
            slug: this.slugs.get(companyId) ?? '',
          })),
        setStatus: (companyId, status) => {
          statuses.set(companyId, status);
          return Promise.resolve();
        },
        rename: (companyId, name) => {
          names.set(companyId, name);
          return Promise.resolve();
        },
        remove: (companyId) => {
          const channel = channels.get(companyId) ?? null;
          removed.add(companyId);
          channels.delete(companyId);
          revoked.push(companyId);
          return Promise.resolve(channel);
        },
        state: (companyId) => {
          const slug = this.slugs.get(companyId);
          return Promise.resolve(
            slug === undefined
              ? null
              : { slug, removed: removed.has(companyId), hasChannel: channels.has(companyId) },
          );
        },
        restore: (companyId) => Promise.resolve(removed.delete(companyId)),
        membership: (companyId, membershipId) =>
          Promise.resolve(memberships.get(`${companyId}:${membershipId}`) ?? null),
        setMembershipRole: (companyId, membershipId, role) => {
          const key = `${companyId}:${membershipId}`;
          const current = memberships.get(key);
          if (current !== undefined) memberships.set(key, { ...current, role });
          return Promise.resolve();
        },
        setMembershipStatus: (companyId, membershipId, status) => {
          const key = `${companyId}:${membershipId}`;
          const current = memberships.get(key);
          if (current !== undefined) memberships.set(key, { ...current, status });
          return Promise.resolve();
        },
        activeOwners: (companyId) =>
          Promise.resolve(
            [...memberships]
              .filter(([key]) => key.startsWith(`${companyId}:`))
              .filter(
                ([, m]) =>
                  m.role === 'OWNER' &&
                  m.status === 'ACTIVE' &&
                  (m.account === null || m.account.status === 'ACTIVE'),
              ).length,
          ),
        audit: (event) => {
          if (this.failAudit) return Promise.reject(new Error('trilha indisponível'));
          events.push(event);
          return Promise.resolve();
        },
      });
      // Só no fim, como o commit.
      for (const [id, status] of statuses) this.statuses.set(id, status);
      for (const [id, name] of names) this.names.set(id, name);
      this.removed.clear();
      for (const id of removed) this.removed.add(id);
      this.channels.clear();
      for (const [id, channel] of channels) this.channels.set(id, channel);
      for (const [key, membership] of memberships) this.memberships.set(key, membership);
      this.invitationsRevoked.push(...revoked);
      for (const event of events) await this.audit.create(event);
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/**
 * Ações da plataforma sobre contas (spec 045, E2) em memória: contas, vínculos e a contagem de empresas em
 * que a conta é o único dono ativo (`soleOwner`, posta pelo teste). Registra a ordem das travas
 * (`locks`) e grava só no fim (como o commit); `failAudit` faz a gravação da trilha falhar.
 */
export class InMemoryPlatformAccountUnitOfWork implements PlatformAccountUnitOfWork {
  readonly accounts = new Map<string, PlatformLockedAccount>();
  readonly memberships: (PlatformAccountMembershipRef & { readonly accountId: string })[] = [];
  readonly soleOwner = new Map<string, number>();
  readonly locks: string[] = [];
  failAudit = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly audit: InMemoryPlatformAuditRepository = new InMemoryPlatformAuditRepository(),
  ) {}

  run<T>(fn: (tx: PlatformAccountTransaction) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const pending = new Map<string, AccessStatus>();
      const events: NewPlatformAuditEvent[] = [];
      const result = await fn({
        lockOwnedCompanies: (accountId) => {
          this.locks.push(`companies:${accountId}`);
          return Promise.resolve(this.soleOwner.get(accountId) ?? 0);
        },
        lockAccount: (accountId) => {
          this.locks.push(`account:${accountId}`);
          const account = this.accounts.get(accountId);
          if (account === undefined) {
            return Promise.reject(new NotFoundError('Conta não encontrada'));
          }
          return Promise.resolve({ ...account, status: pending.get(accountId) ?? account.status });
        },
        soleActiveOwnerCompanies: (accountId) =>
          Promise.resolve(this.soleOwner.get(accountId) ?? 0),
        setStatus: (accountId, status) => {
          pending.set(accountId, status);
          return Promise.resolve();
        },
        memberships: (accountId) =>
          Promise.resolve(
            this.memberships
              .filter((ref) => ref.accountId === accountId)
              .map(({ companyId, membershipId }) => ({ companyId, membershipId })),
          ),
        audit: (event) => {
          if (this.failAudit) return Promise.reject(new Error('trilha indisponível'));
          events.push(event);
          return Promise.resolve();
        },
      });
      // Só no fim, como o commit: falha no meio não grava nada.
      for (const [id, status] of pending) {
        const account = this.accounts.get(id);
        if (account !== undefined) this.accounts.set(id, { ...account, status });
      }
      for (const event of events) await this.audit.create(event);
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

type Overrides = { -readonly [K in keyof PlatformReadModel]?: PlatformReadModel[K] };

/** Leitura agregada falsa: cada método devolve o que o teste pôs (ou um padrão vazio) e registra a chamada. */
export class FakePlatformReadModel implements PlatformReadModel {
  readonly calls: { readonly method: keyof PlatformReadModel; readonly args: unknown[] }[] = [];

  constructor(private readonly overrides: Overrides = {}) {}

  private record(method: keyof PlatformReadModel, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  overview(now: Date): Promise<PlatformOverviewFacts> {
    this.record('overview', [now]);
    if (this.overrides.overview !== undefined) return this.overrides.overview(now);
    const volume = { contactMessages: 0, replies: 0, fallbackReplies: 0 };
    return Promise.resolve({
      companies: { active: 0, suspended: 0 },
      accounts: { total: 0, verified: 0, unverified: 0, disabled: 0 },
      channel: {
        byState: { NOT_CONNECTED: 0, CONNECTED: 0, TOKEN_INVALID: 0, LEGACY: 0 },
        byMode: { API_ONLY: 0, COEXISTENCE: 0 },
      },
      attendance: { last24h: volume, last7d: volume },
      attention: {
        stalledPending: 0,
        unsentReplies: 0,
        tokenInvalid: 0,
        tokensExpiringSoon: 0,
        openHandoffs: 0,
      },
    });
  }

  billingOverview(now: Date, graceDays: number, monthStart: Date) {
    this.record('billingOverview', [now, graceDays, monthStart]);
    if (this.overrides.billingOverview !== undefined) {
      return this.overrides.billingOverview(now, graceDays, monthStart);
    }
    return Promise.resolve({ subscriptions: [], paidOrders: { count: 0, amountCents: 0 } });
  }

  listCompanies(...args: Parameters<PlatformReadModel['listCompanies']>) {
    this.record('listCompanies', args);
    return (
      this.overrides.listCompanies?.(...args) ?? Promise.resolve({ items: [], nextCursor: null })
    );
  }

  companyDetail(...args: Parameters<PlatformReadModel['companyDetail']>) {
    this.record('companyDetail', args);
    return this.overrides.companyDetail?.(...args) ?? Promise.resolve(null);
  }

  subscription(...args: Parameters<PlatformReadModel['subscription']>) {
    this.record('subscription', args);
    return this.overrides.subscription?.(...args) ?? Promise.resolve(null);
  }

  listAccounts(...args: Parameters<PlatformReadModel['listAccounts']>) {
    this.record('listAccounts', args);
    return (
      this.overrides.listAccounts?.(...args) ?? Promise.resolve({ items: [], nextCursor: null })
    );
  }

  accountDetail(...args: Parameters<PlatformReadModel['accountDetail']>) {
    this.record('accountDetail', args);
    return this.overrides.accountDetail?.(...args) ?? Promise.resolve(null);
  }

  accountEmail(...args: Parameters<PlatformReadModel['accountEmail']>) {
    this.record('accountEmail', args);
    return this.overrides.accountEmail?.(...args) ?? Promise.resolve(null);
  }

  listOrders(...args: Parameters<PlatformReadModel['listOrders']>) {
    this.record('listOrders', args);
    return this.overrides.listOrders?.(...args) ?? Promise.resolve({ items: [], nextCursor: null });
  }

  listNotices(...args: Parameters<PlatformReadModel['listNotices']>) {
    this.record('listNotices', args);
    return (
      this.overrides.listNotices?.(...args) ?? Promise.resolve({ items: [], nextCursor: null })
    );
  }
}
