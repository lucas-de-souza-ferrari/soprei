import type { FastifyBaseLogger } from 'fastify';
import {
  type AuditAction,
  type AuditEvent,
  type AuditRepository,
  canManageRole,
  hasPermission,
  type ListOptions,
  type Page,
  type Permission,
  type User,
  type UserCredentials,
  type UserRepository,
  type UserRole,
  type UserStatus,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { loginLockKey } from '../auth/auth.service.js';
import { normalizeEmail } from '../auth/credentials.js';
import type { UserIdentity } from '../auth/identity.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { SessionStore } from '../ports/session-store.js';
import type {
  UserAdminTransaction,
  UserAdminUnitOfWork,
} from '../ports/user-admin-unit-of-work.js';

/** Hashes desta classe usam a fila de administração do hasher (teto menor; não esgotam o login). */
const ADMIN_LANE = { lane: 'admin' } as const;

/** Código do `ConflictError` quando a operação deixaria o cliente sem `OWNER` ativo. */
export const LAST_OWNER_CODE = 'LAST_OWNER';

/** O que a API devolve de um usuário: nunca o hash da senha. */
export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  /** Já validado e normalizado; o service normaliza de novo por segurança. */
  readonly email: string;
  /** Já validada pela política (12 a 128, NFKC, sem NUL). */
  readonly password: string;
  readonly role: UserRole;
}

export interface UpdateUserInput {
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

type AdminMetrics = Pick<Metrics, 'countUserAdminAction'>;

export interface UserAdminServiceDeps {
  /** Leituras fora de transação (listagem). As escritas passam sempre pela `unitOfWork`. */
  readonly users: UserRepository;
  readonly audit: AuditRepository;
  readonly unitOfWork: UserAdminUnitOfWork;
  readonly hasher: PasswordHasher;
  readonly sessions: SessionStore;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: AdminMetrics | undefined;
  /** Chave do HMAC do contador de falhas da troca de senha (a mesma derivada do `JWT_SECRET`). */
  readonly loginLockSecret: string | Buffer;
}

function toView(user: User): UserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

/** Evento a gravar (sem `clientId`: vem do ator). */
interface PendingAudit {
  readonly action: AuditAction;
  readonly targetUserId: string;
  readonly fromRole?: UserRole | null;
  readonly toRole?: UserRole | null;
}

/**
 * Gestão de usuários do próprio cliente, troca da própria senha e leitura da auditoria (spec 008).
 *
 * Regras que **este service** reaplica (o hook `requirePermission` sozinho não as expressa):
 * - permissão pelo papel do ator; nas operações de escrita, o papel e o estado do ator são
 *   **relidos do banco, dentro da transação**, então um token ainda válido de quem acabou de ser
 *   rebaixado ou desativado (a revogação de sessões falhou) não age com o papel antigo;
 * - hierarquia (`canManageRole`) sobre o papel atual do alvo **e** sobre o papel a atribuir;
 * - ninguém altera o próprio papel, estado nem a senha por aqui;
 * - nenhuma operação deixa o cliente sem `OWNER` ativo: a checagem e a escrita acontecem na mesma
 *   transação, com a linha do cliente travada (`lockClient`), senão dois `OWNER` se rebaixando ao
 *   mesmo tempo passariam cada um pela checagem sozinho;
 * - a auditoria é gravada **na mesma transação** da mudança.
 *
 * Depois do commit (banco primeiro, revogação depois) as sessões do alvo são revogadas; se o Redis
 * falhar, o erro (`ServiceUnavailableError`, 503) sobe com a mudança e a auditoria já gravadas, e
 * repetir o pedido refaz a revogação. O `ClientId` vem sempre do ator (token). **Nunca** loga
 * e-mail, senha, hash nem token: só ids, papéis e a ação.
 */
export class UserAdminService {
  private readonly users: UserRepository;
  private readonly audit: AuditRepository;
  private readonly unitOfWork: UserAdminUnitOfWork;
  private readonly hasher: PasswordHasher;
  private readonly sessions: SessionStore;
  private readonly logger: FastifyBaseLogger;
  private readonly metrics: AdminMetrics | undefined;
  private readonly loginLockSecret: string | Buffer;

  constructor(deps: UserAdminServiceDeps) {
    this.users = deps.users;
    this.audit = deps.audit;
    this.unitOfWork = deps.unitOfWork;
    this.hasher = deps.hasher;
    this.sessions = deps.sessions;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.loginLockSecret = deps.loginLockSecret;
  }

  async listUsers(actor: UserIdentity, options?: ListOptions): Promise<Page<UserView>> {
    this.requirePermission(actor, 'user:read');
    const page = await this.users.list(actor.clientId, options);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  listAuditEvents(actor: UserIdentity, options?: ListOptions): Promise<Page<AuditEvent>> {
    this.requirePermission(actor, 'audit:read');
    return this.audit.list(actor.clientId, options);
  }

  async createUser(actor: UserIdentity, input: CreateUserInput): Promise<UserView> {
    // Cheque barato, pelo papel do token, antes de gastar um hash; a decisão final é a de dentro
    // da transação (papel relido do banco).
    this.requireManage(actor, input.role);
    const email = normalizeEmail(input.email);
    const passwordHash = await this.hasher.hash(input.password, ADMIN_LANE);

    const created = await this.unitOfWork.run(async (tx) => {
      await tx.lockClient(actor.clientId);
      const current = await this.loadManager(tx, actor);
      this.requireHierarchy(actor, current.role, input.role, 'create');
      const user = await tx.users.create(actor.clientId, {
        email,
        passwordHash,
        role: input.role,
      });
      await this.record(tx, actor, {
        action: 'USER_CREATED',
        targetUserId: user.id,
        toRole: user.role,
      });
      return user;
    });
    this.afterCommit(actor, [
      { action: 'USER_CREATED', targetUserId: created.id, toRole: created.role },
    ]);
    return toView(created);
  }

  async updateUser(
    actor: UserIdentity,
    targetId: string,
    patch: UpdateUserInput,
  ): Promise<UserView> {
    this.requirePermission(actor, 'user:manage');

    const outcome = await this.unitOfWork.run(async (tx) => {
      await tx.lockClient(actor.clientId);
      const current = await this.loadManager(tx, actor);
      const target = await tx.users.findById(actor.clientId, targetId);
      this.requireNotSelf(actor, target, 'update');
      this.requireHierarchy(actor, current.role, target.role, 'update');

      const roleChanges = patch.role !== undefined && patch.role !== target.role;
      const statusChanges = patch.status !== undefined && patch.status !== target.status;
      if (roleChanges) this.requireHierarchy(actor, current.role, patch.role, 'assign');

      // Regra do último OWNER: só importa para quem é OWNER **ativo** agora e deixaria de ser.
      const stopsBeingOwner =
        target.role === 'OWNER' &&
        target.status === 'ACTIVE' &&
        ((roleChanges && patch.role !== 'OWNER') || (statusChanges && patch.status === 'DISABLED'));
      if (stopsBeingOwner && (await tx.users.countActiveOwners(actor.clientId)) <= 1) {
        this.logger.warn(
          { actorUserId: actor.userId, targetUserId: target.id, reason: 'last_owner' },
          'operação recusada: o cliente ficaria sem proprietário ativo',
        );
        throw new ConflictError('O cliente precisa ter ao menos um proprietário ativo', {
          code: LAST_OWNER_CODE,
          context: { reason: 'last_owner' },
        });
      }

      const events: PendingAudit[] = [];
      if (roleChanges) {
        events.push({
          action: 'USER_ROLE_CHANGED',
          targetUserId: target.id,
          fromRole: target.role,
          toRole: patch.role ?? null,
        });
      }
      if (statusChanges) {
        events.push({
          action: patch.status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED',
          targetUserId: target.id,
        });
      }

      let user = target;
      if (events.length > 0) {
        user = await tx.users.update(actor.clientId, target.id, {
          ...(roleChanges ? { role: patch.role } : {}),
          ...(statusChanges ? { status: patch.status } : {}),
        });
        for (const event of events) await this.record(tx, actor, event);
      }
      return { user, events };
    });

    this.afterCommit(actor, outcome.events);
    // Papel novo e desativação derrubam as sessões do alvo (ele refaz o login com o papel novo).
    // O pedido repetido, já aplicado, ainda refaz a revogação (idempotente) caso a primeira tenha
    // parado no Redis; reativar não precisa revogar.
    await this.revokeSessions(actor, outcome.user.id, {
      when: patch.role !== undefined || patch.status === 'DISABLED',
    });
    return toView(outcome.user);
  }

  async resetPassword(actor: UserIdentity, targetId: string, newPassword: string): Promise<void> {
    this.requirePermission(actor, 'user:manage');
    const passwordHash = await this.hasher.hash(newPassword, ADMIN_LANE);

    const targetUserId = await this.unitOfWork.run(async (tx) => {
      await tx.lockClient(actor.clientId);
      const current = await this.loadManager(tx, actor);
      const target = await tx.users.findById(actor.clientId, targetId);
      // A própria senha só pela rota de troca (exige a senha atual).
      this.requireNotSelf(actor, target, 'reset_password');
      this.requireHierarchy(actor, current.role, target.role, 'reset_password');
      await tx.users.updatePassword(actor.clientId, target.id, passwordHash);
      await this.record(tx, actor, { action: 'USER_PASSWORD_RESET', targetUserId: target.id });
      return target.id;
    });
    this.afterCommit(actor, [{ action: 'USER_PASSWORD_RESET', targetUserId }]);
    await this.revokeSessions(actor, targetUserId);
  }

  /**
   * Troca da **própria** senha: confere a atual (um `verify`; falhas contam no mesmo tipo de
   * contador do login, 429 antes de gastar hash), grava o novo hash e revoga **todas** as sessões
   * da pessoa, inclusive a atual (a pessoa faz login de novo). Senha nova igual à atual é aceita.
   */
  async changeOwnPassword(
    actor: UserIdentity,
    input: { readonly currentPassword: string; readonly newPassword: string },
  ): Promise<void> {
    const lockKey = loginLockKey(this.loginLockSecret, ['pw', actor.clientId, actor.userId]);
    const lock = await this.sessions.loginLockState(lockKey);
    if (lock.locked) {
      this.logger.warn({ reason: 'password_change_locked' }, 'troca de senha bloqueada');
      throw new RateLimitError(lock.retryAfterSeconds);
    }

    let credentials: UserCredentials;
    try {
      credentials = await this.users.findCredentialsById(actor.clientId, actor.userId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new UnauthorizedError();
      throw error;
    }
    if (credentials.user.status !== 'ACTIVE') throw new UnauthorizedError();

    const matches = await this.hasher.verify(
      input.currentPassword,
      credentials.passwordHash,
      ADMIN_LANE,
    );
    if (!matches) {
      await this.sessions.recordLoginFailure(lockKey);
      this.logger.info({ result: 'invalid' }, 'troca de senha recusada');
      throw new UnauthorizedError('Credenciais inválidas');
    }
    await this.sessions.resetLoginFailures(lockKey);

    const passwordHash = await this.hasher.hash(input.newPassword, ADMIN_LANE);
    await this.unitOfWork.run(async (tx) => {
      await tx.users.updatePassword(actor.clientId, actor.userId, passwordHash);
      await this.record(tx, actor, {
        action: 'USER_PASSWORD_CHANGED',
        targetUserId: actor.userId,
      });
    });
    this.afterCommit(actor, [{ action: 'USER_PASSWORD_CHANGED', targetUserId: actor.userId }]);
    await this.revokeSessions(actor, actor.userId);
  }

  // --- regras ---

  /** Permissão pelo papel do token (hook já checou; aqui é a defesa em profundidade). */
  private requirePermission(actor: UserIdentity, permission: Permission): void {
    if (hasPermission(actor.role, permission)) return;
    this.deny(actor, 'permission', actor.role);
  }

  /** Cheque barato antes do hash: `user:manage` e o papel a atribuir, pelo papel do token. */
  private requireManage(actor: UserIdentity, assigned: UserRole): void {
    this.requirePermission(actor, 'user:manage');
    this.requireHierarchy(actor, actor.role, assigned, 'create');
  }

  /**
   * O ator, com papel e estado **do banco** (não do token): precisa estar ativo e ter
   * `user:manage`. Ausente, desativado ou sem permissão = 403.
   */
  private async loadManager(tx: UserAdminTransaction, actor: UserIdentity): Promise<User> {
    let current: User;
    try {
      current = await tx.users.findById(actor.clientId, actor.userId);
    } catch (error) {
      if (error instanceof NotFoundError) return this.deny(actor, 'actor_missing', actor.role);
      throw error;
    }
    if (current.status !== 'ACTIVE' || !hasPermission(current.role, 'user:manage')) {
      return this.deny(actor, 'actor_not_allowed', current.role);
    }
    return current;
  }

  private requireNotSelf(actor: UserIdentity, target: User, operation: string): void {
    if (target.id === actor.userId) this.deny(actor, `self_${operation}`, actor.role);
  }

  private requireHierarchy(
    actor: UserIdentity,
    actorRole: UserRole,
    subjectRole: UserRole | undefined,
    operation: string,
  ): void {
    if (!canManageRole(actorRole, subjectRole)) {
      this.deny(actor, `hierarchy_${operation}`, actorRole);
    }
  }

  private deny(actor: UserIdentity, reason: string, role: UserRole): never {
    this.logger.warn(
      { actorUserId: actor.userId, role, reason },
      'operação de usuário negada pela permissão ou hierarquia',
    );
    throw new ForbiddenError();
  }

  // --- efeitos ---

  /** Grava o evento na transação da mudança (sem e-mail, senha nem texto livre). */
  private async record(
    tx: UserAdminTransaction,
    actor: UserIdentity,
    event: PendingAudit,
  ): Promise<void> {
    await tx.audit.create(actor.clientId, {
      action: event.action,
      actorUserId: actor.userId,
      targetUserId: event.targetUserId,
      fromRole: event.fromRole ?? null,
      toRole: event.toRole ?? null,
    });
  }

  /** Log `audit` e métrica, só depois do commit (nada é logado de transação desfeita). */
  private afterCommit(actor: UserIdentity, events: readonly PendingAudit[]): void {
    for (const event of events) {
      this.logger.info(
        {
          event: 'audit',
          action: event.action,
          clientId: actor.clientId,
          actorUserId: actor.userId,
          targetUserId: event.targetUserId,
          fromRole: event.fromRole ?? null,
          toRole: event.toRole ?? null,
        },
        'audit',
      );
      try {
        this.metrics?.countUserAdminAction(event.action);
      } catch (error) {
        this.logger.warn({ err: error }, 'falha ao registrar métrica de gestão de usuários');
      }
    }
  }

  /**
   * Revoga as sessões do alvo **depois** do commit. Falha do Redis sobe como 503 com a mudança já
   * gravada (a tentativa seguinte, idempotente, refaz a revogação).
   */
  private async revokeSessions(
    actor: UserIdentity,
    targetUserId: string,
    options: { readonly when?: boolean } = {},
  ): Promise<void> {
    if (options.when === false) return;
    try {
      await this.sessions.revokeAllSessions(actor.clientId, targetUserId);
    } catch (error) {
      this.logger.error(
        { targetUserId, reason: 'revocation_failed' },
        'mudança gravada, mas a revogação das sessões falhou (repita o pedido)',
      );
      throw error;
    }
  }
}
