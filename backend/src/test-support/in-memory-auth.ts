import { createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService, deriveLoginLockSecret } from '../application/auth/auth.service.js';
import { MembershipAdminService } from '../application/memberships/membership-admin.service.js';
import type {
  MembershipAdminTransaction,
  MembershipAdminUnitOfWork,
} from '../application/ports/membership-admin-unit-of-work.js';
import type {
  HashLane,
  HashOptions,
  PasswordHasher,
} from '../application/ports/password-hasher.js';
import type {
  AccessCheck,
  LoginLock,
  RotateOutcome,
  SessionStore,
} from '../application/ports/session-store.js';
import {
  type AuditAction,
  type AuditEvent,
  type AuditRepository,
  type CompanyId,
  type CompanyRepository,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  type NewAuditEvent,
  type NewPlatformAdmin,
  type NewMembership,
  type Page,
  type PlatformAdmin,
  type PlatformAdminCredentials,
  PlatformAdminId,
  type PlatformAdminRepository,
  type Membership,
  type MembershipCredentials,
  MembershipId,
  type MembershipRepository,
  type MembershipRole,
  type MembershipUpdate,
} from '../domain/index.js';
import { JoseAccessTokenService } from '../infrastructure/auth/jose-access-token.service.js';
import type { Metrics } from '../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError } from '../shared/errors/index.js';
import { InMemoryCompanyRepository } from './in-memory-company.repository.js';

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
  /** A fila pedida em cada `hash`/`verify` (prova que a administração usa a lane `admin`). */
  readonly lanes: (HashLane | undefined)[] = [];

  hash(password: string, options?: HashOptions): Promise<string> {
    this.hashCalls += 1;
    this.lanes.push(options?.lane);
    return Promise.resolve(`fake$${createHash('sha256').update(password).digest('hex')}`);
  }

  verify(password: string, storedHash: string, options?: HashOptions): Promise<boolean> {
    this.verifyCalls += 1;
    this.lanes.push(options?.lane);
    return Promise.resolve(
      storedHash === `fake$${createHash('sha256').update(password).digest('hex')}`,
    );
  }

  dummyHash(): Promise<string> {
    return Promise.resolve('fake$dummy');
  }
}

/** Executa `fn` e devolve o resultado (ou a exceção) como promessa, como um repositório assíncrono. */
function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** `MembershipRepository` em memória com o mesmo isolamento do real: tudo filtrado por `CompanyId`. */
export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly rows: { membership: Membership; passwordHash: string }[] = [];

  findById(companyId: CompanyId, id: string): Promise<Membership> {
    return attempt(() => this.get(companyId, id).membership);
  }

  list(companyId: CompanyId, options: ListOptions = {}): Promise<Page<Membership>> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const all = this.rows
      .filter((row) => row.membership.companyId === companyId)
      .map((row) => row.membership);
    return Promise.resolve(pageOf(all, limit, options.cursor));
  }

  /** Cópia do estado (para o "rollback" da unidade de trabalho em memória). */
  snapshot(): { membership: Membership; passwordHash: string }[] {
    return this.rows.map((row) => ({ membership: row.membership, passwordHash: row.passwordHash }));
  }

  restore(snapshot: readonly { membership: Membership; passwordHash: string }[]): void {
    this.rows.splice(0, this.rows.length, ...snapshot.map((row) => ({ ...row })));
  }

  create(companyId: CompanyId, data: NewMembership): Promise<Membership> {
    if (
      this.rows.some(
        (row) => row.membership.companyId === companyId && row.membership.email === data.email,
      )
    ) {
      return Promise.reject(new ConflictError('Já existe um registro com estes dados'));
    }
    const now = new Date();
    const membership: Membership = {
      id: MembershipId.parse(randomUUID()),
      companyId,
      email: data.email,
      role: data.role ?? 'AGENT',
      status: data.status ?? 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push({ membership, passwordHash: data.passwordHash });
    return Promise.resolve(membership);
  }

  update(companyId: CompanyId, id: string, data: MembershipUpdate): Promise<Membership> {
    return attempt(() => {
      const row = this.get(companyId, id);
      row.membership = { ...row.membership, ...data, updatedAt: new Date() };
      return row.membership;
    });
  }

  delete(companyId: CompanyId, id: string): Promise<void> {
    return attempt(() => {
      const row = this.get(companyId, id);
      this.rows.splice(this.rows.indexOf(row), 1);
    });
  }

  count(companyId: CompanyId): Promise<number> {
    return Promise.resolve(
      this.rows.filter((row) => row.membership.companyId === companyId).length,
    );
  }

  findCredentialsByEmail(
    companyId: CompanyId,
    email: string,
  ): Promise<MembershipCredentials | null> {
    const row = this.rows.find(
      (r) => r.membership.companyId === companyId && r.membership.email === email,
    );
    return Promise.resolve(
      row === undefined ? null : { membership: row.membership, passwordHash: row.passwordHash },
    );
  }

  findCredentialsById(companyId: CompanyId, id: string): Promise<MembershipCredentials> {
    return attempt(() => {
      const row = this.get(companyId, id);
      return { membership: row.membership, passwordHash: row.passwordHash };
    });
  }

  countActiveOwners(companyId: CompanyId): Promise<number> {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.membership.companyId === companyId &&
          row.membership.role === 'OWNER' &&
          row.membership.status === 'ACTIVE',
      ).length,
    );
  }

  updatePassword(companyId: CompanyId, id: string, passwordHash: string): Promise<void> {
    return attempt(() => {
      this.get(companyId, id).passwordHash = passwordHash;
    });
  }

  private get(companyId: CompanyId, id: string): { membership: Membership; passwordHash: string } {
    const row = this.rows.find(
      (r) => r.membership.companyId === companyId && r.membership.id === id,
    );
    if (row === undefined) throw new NotFoundError('Recurso não encontrado');
    return row;
  }
}

/** Paginação por deslocamento opaco (o cursor é só o índice em base64), para os testes em memória. */
function pageOf<T>(all: readonly T[], limit: number, cursor: string | undefined): Page<T> {
  const start = cursor === undefined ? 0 : Number(Buffer.from(cursor, 'base64url').toString());
  const items = all.slice(start, start + limit);
  const next = start + limit;
  return {
    items,
    nextCursor: next < all.length ? Buffer.from(String(next)).toString('base64url') : null,
  };
}

/** Auditoria em memória: só `create` e `list` (mais recentes primeiro), como o repositório real. */
export class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];
  /** Liga uma falha na gravação da trilha (para provar que a mudança do usuário é desfeita). */
  failWith: Error | undefined;
  /** Relógio dos eventos (os testes de cota o injetam). */
  now: () => Date = () => new Date();

  countSince(
    companyId: CompanyId,
    filter: {
      readonly actions: readonly AuditAction[];
      readonly since: Date;
      readonly actorMembershipId?: string;
    },
  ): Promise<number> {
    return Promise.resolve(
      this.events.filter(
        (event) =>
          event.companyId === companyId &&
          filter.actions.includes(event.action) &&
          event.createdAt.getTime() >= filter.since.getTime() &&
          (filter.actorMembershipId === undefined ||
            event.actorMembershipId === filter.actorMembershipId),
      ).length,
    );
  }

  create(companyId: CompanyId, data: NewAuditEvent): Promise<AuditEvent> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const event: AuditEvent = {
      id: randomUUID(),
      companyId,
      action: data.action,
      actorMembershipId: data.actorMembershipId,
      targetMembershipId: data.targetMembershipId ?? null,
      fromRole: data.fromRole ?? null,
      toRole: data.toRole ?? null,
      invitationId: data.invitationId ?? null,
      createdAt: this.now(),
    };
    this.events.push(event);
    return Promise.resolve(event);
  }

  list(companyId: CompanyId, options: ListOptions = {}): Promise<Page<AuditEvent>> {
    const all = this.events.filter((event) => event.companyId === companyId).reverse();
    return Promise.resolve(pageOf(all, options.limit ?? DEFAULT_LIST_LIMIT, options.cursor));
  }

  snapshot(): AuditEvent[] {
    return [...this.events];
  }

  restore(snapshot: readonly AuditEvent[]): void {
    this.events.splice(0, this.events.length, ...snapshot);
  }
}

/**
 * Unidade de trabalho em memória: serializa as execuções (o papel do bloqueio da empresa) e desfaz
 * usuários e auditoria se `fn` lançar (o papel do rollback).
 */
export class InMemoryMembershipAdminUnitOfWork implements MembershipAdminUnitOfWork {
  private tail: Promise<unknown> = Promise.resolve();
  /** Quantas vezes `lockCompany` foi chamado (os testes provam que toda escrita trava a empresa). */
  lockCalls = 0;

  constructor(
    private readonly memberships: InMemoryMembershipRepository,
    private readonly audit: InMemoryAuditRepository,
  ) {}

  run<T>(fn: (tx: MembershipAdminTransaction) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const memberships = this.memberships.snapshot();
      const events = this.audit.snapshot();
      try {
        return await fn({
          memberships: this.memberships,
          audit: this.audit,
          lockCompany: () => {
            this.lockCalls += 1;
            return Promise.resolve();
          },
        });
      } catch (error) {
        this.memberships.restore(memberships);
        this.audit.restore(events);
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
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
  /** Falha só em `revokeAllSessions` (o Redis "cai" depois do commit da gestão de usuários). */
  failRevokeAllWith: Error | undefined;

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
    if (this.failRevokeAllWith !== undefined) return Promise.reject(this.failRevokeAllWith);
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
  readonly companies?: CompanyRepository;
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
  readonly membershipId: string;
}

/**
 * Autenticação completa em memória para testes de rota: o `AuthService` real, `jose` de verdade,
 * hasher falso e `SessionStore` em memória. `membershipToken`/`platformToken` fazem o login de verdade
 * (conta nova com e-mail único) e devolvem os tokens para o cabeçalho `Authorization`.
 */
export function buildTestAuth(options: TestAuthOptions) {
  const companies = options.companies ?? new InMemoryCompanyRepository();
  const memberships = new InMemoryMembershipRepository();
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
  const audit = new InMemoryAuditRepository();
  const unitOfWork = new InMemoryMembershipAdminUnitOfWork(memberships, audit);
  const membershipAdmin = new MembershipAdminService({
    memberships,
    audit,
    unitOfWork,
    hasher,
    sessions,
    logger: options.logger,
    metrics: options.metrics,
    loginLockSecret: deriveLoginLockSecret(TEST_JWT_SECRET),
  });
  const service = new AuthService({
    companies,
    memberships,
    platformAdmins,
    hasher,
    tokens,
    sessions,
    logger: options.logger,
    metrics: options.metrics,
    loginLockSecret: deriveLoginLockSecret(TEST_JWT_SECRET),
  });

  async function membershipToken(
    companyId: CompanyId,
    opts: { role?: MembershipRole; email?: string } = {},
  ): Promise<IssuedLogin> {
    const company = await companies.findById(companyId);
    const email = opts.email ?? `u-${randomUUID()}@exemplo.test`;
    const membership = await memberships.create(companyId, {
      email,
      passwordHash: await hasher.hash(TEST_PASSWORD),
      role: opts.role ?? 'OWNER',
    });
    const result = await service.login({
      companySlug: company.slug,
      email,
      password: TEST_PASSWORD,
    });
    if (!result.ok) throw new Error(`login de teste falhou: ${result.error.reason}`);
    return {
      accessToken: result.value.accessToken,
      refreshToken: result.value.refreshToken,
      email,
      membershipId: membership.id,
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
      membershipId: admin.id,
    };
  }

  return {
    service,
    companies,
    memberships,
    audit,
    unitOfWork,
    membershipAdmin,
    platformAdmins,
    hasher,
    sessions,
    tokens,
    membershipToken,
    platformToken,
  };
}

export type TestAuth = ReturnType<typeof buildTestAuth>;

/** Cabeçalho `Authorization` de um token. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
