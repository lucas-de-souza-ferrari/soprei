import { createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService, deriveLoginLockSecret } from '../application/auth/auth.service.js';
import type { PasswordHasher } from '../application/ports/password-hasher.js';
import type {
  AccessCheck,
  LoginLock,
  RotateOutcome,
  SessionStore,
} from '../application/ports/session-store.js';
import {
  type ClientId,
  type ClientRepository,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  type NewPlatformAdmin,
  type NewUser,
  type Page,
  type PlatformAdmin,
  type PlatformAdminCredentials,
  PlatformAdminId,
  type PlatformAdminRepository,
  type User,
  type UserCredentials,
  UserId,
  type UserRepository,
  type UserRole,
  type UserUpdate,
} from '../domain/index.js';
import { JoseAccessTokenService } from '../infrastructure/auth/jose-access-token.service.js';
import type { Metrics } from '../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError } from '../shared/errors/index.js';
import { InMemoryClientRepository } from './in-memory-client.repository.js';

export const TEST_JWT_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0123456789';
export const TEST_PASSWORD = 'senha-de-teste-forte-123';

/**
 * Hasher barato e determinístico para os testes de fluxo (o scrypt de verdade, a 128 MiB por
 * hash, fica nos testes do próprio hasher). Conta as chamadas a `verify` para provar que o login
 * faz o mesmo trabalho em todos os caminhos.
 */
export class FakePasswordHasher implements PasswordHasher {
  verifyCalls = 0;
  hashCalls = 0;

  hash(password: string): Promise<string> {
    this.hashCalls += 1;
    return Promise.resolve(`fake$${createHash('sha256').update(password).digest('hex')}`);
  }

  verify(password: string, storedHash: string): Promise<boolean> {
    this.verifyCalls += 1;
    return Promise.resolve(
      storedHash === `fake$${createHash('sha256').update(password).digest('hex')}`,
    );
  }

  dummyHash(): Promise<string> {
    return Promise.resolve('fake$dummy');
  }
}

/** `UserRepository` em memória com o mesmo isolamento do real: tudo filtrado por `ClientId`. */
export class InMemoryUserRepository implements UserRepository {
  private readonly rows: { user: User; passwordHash: string }[] = [];

  findById(clientId: ClientId, id: string): Promise<User> {
    return Promise.resolve(this.get(clientId, id).user);
  }

  list(clientId: ClientId, options: ListOptions = {}): Promise<Page<User>> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const items = this.rows
      .filter((row) => row.user.clientId === clientId)
      .map((row) => row.user)
      .slice(0, limit);
    return Promise.resolve({ items, nextCursor: null });
  }

  create(clientId: ClientId, data: NewUser): Promise<User> {
    if (this.rows.some((row) => row.user.clientId === clientId && row.user.email === data.email)) {
      return Promise.reject(new ConflictError('Já existe um registro com estes dados'));
    }
    const now = new Date();
    const user: User = {
      id: UserId.parse(randomUUID()),
      clientId,
      email: data.email,
      role: data.role ?? 'AGENT',
      status: data.status ?? 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push({ user, passwordHash: data.passwordHash });
    return Promise.resolve(user);
  }

  update(clientId: ClientId, id: string, data: UserUpdate): Promise<User> {
    const row = this.get(clientId, id);
    row.user = { ...row.user, ...data, updatedAt: new Date() };
    return Promise.resolve(row.user);
  }

  delete(clientId: ClientId, id: string): Promise<void> {
    const row = this.get(clientId, id);
    this.rows.splice(this.rows.indexOf(row), 1);
    return Promise.resolve();
  }

  count(clientId: ClientId): Promise<number> {
    return Promise.resolve(this.rows.filter((row) => row.user.clientId === clientId).length);
  }

  findCredentialsByEmail(clientId: ClientId, email: string): Promise<UserCredentials | null> {
    const row = this.rows.find((r) => r.user.clientId === clientId && r.user.email === email);
    return Promise.resolve(
      row === undefined ? null : { user: row.user, passwordHash: row.passwordHash },
    );
  }

  findCredentialsById(clientId: ClientId, id: string): Promise<UserCredentials> {
    const row = this.get(clientId, id);
    return Promise.resolve({ user: row.user, passwordHash: row.passwordHash });
  }

  countActiveOwners(clientId: ClientId): Promise<number> {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.user.clientId === clientId &&
          row.user.role === 'OWNER' &&
          row.user.status === 'ACTIVE',
      ).length,
    );
  }

  updatePassword(clientId: ClientId, id: string, passwordHash: string): Promise<void> {
    this.get(clientId, id).passwordHash = passwordHash;
    return Promise.resolve();
  }

  private get(clientId: ClientId, id: string): { user: User; passwordHash: string } {
    const row = this.rows.find((r) => r.user.clientId === clientId && r.user.id === id);
    if (row === undefined) throw new NotFoundError('Recurso não encontrado');
    return row;
  }
}

export class InMemoryPlatformAdminRepository implements PlatformAdminRepository {
  private readonly rows: { admin: PlatformAdmin; passwordHash: string }[] = [];

  findCredentialsByEmail(email: string): Promise<PlatformAdminCredentials | null> {
    const row = this.rows.find((r) => r.admin.email === email);
    return Promise.resolve(
      row === undefined ? null : { admin: row.admin, passwordHash: row.passwordHash },
    );
  }

  findById(id: PlatformAdminId): Promise<PlatformAdmin> {
    const row = this.rows.find((r) => r.admin.id === id);
    if (row === undefined) return Promise.reject(new NotFoundError('Administrador não encontrado'));
    return Promise.resolve(row.admin);
  }

  create(data: NewPlatformAdmin): Promise<PlatformAdmin> {
    if (this.rows.some((r) => r.admin.email === data.email)) {
      return Promise.reject(new ConflictError('Já existe um registro com estes dados'));
    }
    const now = new Date();
    const admin: PlatformAdmin = {
      id: PlatformAdminId.parse(randomUUID()),
      email: data.email,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push({ admin, passwordHash: data.passwordHash });
    return Promise.resolve(admin);
  }

  updatePassword(id: PlatformAdminId, passwordHash: string): Promise<void> {
    const row = this.rows.find((r) => r.admin.id === id);
    if (row === undefined) return Promise.reject(new NotFoundError('Administrador não encontrado'));
    row.passwordHash = passwordHash;
    return Promise.resolve();
  }

  /** Atalho dos testes: muda o status do administrador. */
  setStatus(id: PlatformAdminId, status: PlatformAdmin['status']): void {
    const row = this.rows.find((r) => r.admin.id === id);
    if (row !== undefined) row.admin = { ...row.admin, status };
  }
}

interface MemorySession {
  readonly subjectId: string;
  current: string;
  used: string[];
  revoked: boolean;
}

/**
 * `SessionStore` em memória, com a mesma semântica do Redis (rotação, reuso, revogação, `nbf`,
 * bloqueio por conta), sem TTL. Os testes de prazo e de atomicidade ficam no Redis real.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, MemorySession>();
  private readonly revokedSessions = new Set<string>();
  private readonly notBefore = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  /** Liga um "Redis fora": toda operação lança `error`. */
  failWith: Error | undefined;

  constructor(
    private readonly options: {
      readonly maxFailures?: number;
      readonly lockSeconds?: number;
      readonly now?: () => Date;
    } = {},
  ) {}

  private check(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }

  private static key(scope: string, id: string): string {
    return `${scope}:${id}`;
  }

  createSession(input: {
    scope: string;
    sessionId: string;
    subjectId: string;
    refreshHash: string;
  }): Promise<void> {
    this.check();
    this.sessions.set(InMemorySessionStore.key(input.scope, input.sessionId), {
      subjectId: input.subjectId,
      current: input.refreshHash,
      used: [],
      revoked: false,
    });
    return Promise.resolve();
  }

  rotate(input: {
    scope: string;
    sessionId: string;
    presentedHash: string;
    newHash: string;
  }): Promise<RotateOutcome> {
    this.check();
    const key = InMemorySessionStore.key(input.scope, input.sessionId);
    const session = this.sessions.get(key);
    if (session === undefined || session.revoked) return Promise.resolve({ status: 'invalid' });
    if (input.presentedHash === session.current) {
      session.used.unshift(session.current);
      session.used = session.used.slice(0, 50);
      session.current = input.newHash;
      return Promise.resolve({ status: 'rotated', subjectId: session.subjectId });
    }
    if (session.used.includes(input.presentedHash)) {
      session.revoked = true;
      this.revokedSessions.add(key);
      return Promise.resolve({ status: 'reuse', subjectId: session.subjectId });
    }
    return Promise.resolve({ status: 'invalid' });
  }

  revokeByRefresh(input: {
    scope: string;
    sessionId: string;
    presentedHash: string;
  }): Promise<boolean> {
    this.check();
    const key = InMemorySessionStore.key(input.scope, input.sessionId);
    const session = this.sessions.get(key);
    if (session === undefined) return Promise.resolve(false);
    if (input.presentedHash !== session.current && !session.used.includes(input.presentedHash)) {
      return Promise.resolve(false);
    }
    session.revoked = true;
    this.revokedSessions.add(key);
    return Promise.resolve(true);
  }

  revokeSession(scope: string, sessionId: string): Promise<void> {
    this.check();
    const key = InMemorySessionStore.key(scope, sessionId);
    const session = this.sessions.get(key);
    if (session !== undefined) session.revoked = true;
    this.revokedSessions.add(key);
    return Promise.resolve();
  }

  revokeAllSessions(scope: string, subjectId: string): Promise<void> {
    this.check();
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${scope}:`) && session.subjectId === subjectId) {
        session.revoked = true;
        this.revokedSessions.add(key);
      }
    }
    const now = Math.floor((this.options.now ?? (() => new Date()))().getTime() / 1000);
    this.notBefore.set(InMemorySessionStore.key(scope, subjectId), now);
    return Promise.resolve();
  }

  checkAccess(input: {
    scope: string;
    sessionId: string;
    subjectId: string;
    issuedAt: number;
  }): Promise<AccessCheck> {
    this.check();
    if (this.revokedSessions.has(InMemorySessionStore.key(input.scope, input.sessionId))) {
      return Promise.resolve('revoked');
    }
    const notBefore = this.notBefore.get(InMemorySessionStore.key(input.scope, input.subjectId));
    return Promise.resolve(
      notBefore !== undefined && input.issuedAt < notBefore ? 'revoked' : 'ok',
    );
  }

  loginLockState(key: string): Promise<LoginLock> {
    this.check();
    const count = this.failures.get(key) ?? 0;
    if (count >= (this.options.maxFailures ?? 5)) {
      return Promise.resolve({ locked: true, retryAfterSeconds: this.options.lockSeconds ?? 900 });
    }
    return Promise.resolve({ locked: false });
  }

  recordLoginFailure(key: string): Promise<void> {
    this.check();
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    return Promise.resolve();
  }

  resetLoginFailures(key: string): Promise<void> {
    this.check();
    this.failures.delete(key);
    return Promise.resolve();
  }
}

export interface TestAuthOptions {
  readonly logger: FastifyBaseLogger;
  readonly clients?: ClientRepository;
  readonly metrics?: Metrics | undefined;
  readonly now?: () => Date;
  readonly ttlSeconds?: number;
  readonly clockToleranceSeconds?: number;
  readonly maxFailures?: number;
  readonly sessions?: SessionStore;
}

export interface IssuedLogin {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly email: string;
  readonly userId: string;
}

/**
 * Autenticação completa em memória para testes de rota: o `AuthService` real, `jose` de verdade,
 * hasher falso e `SessionStore` em memória. `userToken`/`platformToken` fazem o login de verdade
 * (conta nova com e-mail único) e devolvem os tokens para o cabeçalho `Authorization`.
 */
export function buildTestAuth(options: TestAuthOptions) {
  const clients = options.clients ?? new InMemoryClientRepository();
  const users = new InMemoryUserRepository();
  const platformAdmins = new InMemoryPlatformAdminRepository();
  const hasher = new FakePasswordHasher();
  const sessions =
    options.sessions ??
    new InMemorySessionStore({
      ...(options.maxFailures === undefined ? {} : { maxFailures: options.maxFailures }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const tokens = new JoseAccessTokenService({
    secret: TEST_JWT_SECRET,
    issuer: 'soprei',
    audience: 'soprei-api',
    ttlSeconds: options.ttlSeconds ?? 900,
    clockToleranceSeconds: options.clockToleranceSeconds ?? 5,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const service = new AuthService({
    clients,
    users,
    platformAdmins,
    hasher,
    tokens,
    sessions,
    logger: options.logger,
    metrics: options.metrics,
    loginLockSecret: deriveLoginLockSecret(TEST_JWT_SECRET),
  });

  async function userToken(
    clientId: ClientId,
    opts: { role?: UserRole; email?: string } = {},
  ): Promise<IssuedLogin> {
    const client = await clients.findById(clientId);
    const email = opts.email ?? `u-${randomUUID()}@exemplo.test`;
    const user = await users.create(clientId, {
      email,
      passwordHash: await hasher.hash(TEST_PASSWORD),
      role: opts.role ?? 'OWNER',
    });
    const result = await service.login({ clientSlug: client.slug, email, password: TEST_PASSWORD });
    if (!result.ok) throw new Error(`login de teste falhou: ${result.error.reason}`);
    return {
      accessToken: result.value.accessToken,
      refreshToken: result.value.refreshToken,
      email,
      userId: user.id,
    };
  }

  async function platformToken(email = `p-${randomUUID()}@exemplo.test`): Promise<IssuedLogin> {
    const admin = await platformAdmins.create({
      email,
      passwordHash: await hasher.hash(TEST_PASSWORD),
    });
    const result = await service.loginPlatform({ email, password: TEST_PASSWORD });
    if (!result.ok) throw new Error(`login de teste falhou: ${result.error.reason}`);
    return {
      accessToken: result.value.accessToken,
      refreshToken: result.value.refreshToken,
      email,
      userId: admin.id,
    };
  }

  return {
    service,
    clients,
    users,
    platformAdmins,
    hasher,
    sessions,
    tokens,
    userToken,
    platformToken,
  };
}

export type TestAuth = ReturnType<typeof buildTestAuth>;

/** Cabeçalho `Authorization` de um token. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
