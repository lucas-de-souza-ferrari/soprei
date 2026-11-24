import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type Company,
  CompanyId,
  type CompanyRepository,
  PlatformAdminId,
  type PlatformAdminRepository,
  MembershipId,
  type MembershipRepository,
  type MembershipRole,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';
import type { AccessTokenService } from '../ports/access-token-service.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { SessionStore } from '../ports/session-store.js';
import type { PlatformSecondFactor } from '../platform/totp-second-factor.js';
import {
  type AuthIdentity,
  PLATFORM_SCOPE,
  type PlatformIdentity,
  scopeOf,
  subjectIdOf,
  type MembershipIdentity,
} from './identity.js';

export interface AuthTokens {
  readonly accessToken: string;
  /** Entregue **uma vez**; só o hash do segredo fica no Redis. */
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

/** Falhas esperadas do login; a camada de apresentação as traduz em erros da hierarquia. */
export type LoginFailure =
  | { readonly reason: 'invalid_credentials' }
  | { readonly reason: 'locked'; readonly retryAfterSeconds: number }
  | { readonly reason: 'unavailable' };

export type RefreshFailure =
  | { readonly reason: 'invalid_refresh' }
  | { readonly reason: 'reuse_detected' }
  | { readonly reason: 'unavailable' };

export type AuthenticateFailure =
  | { readonly reason: 'invalid' }
  | { readonly reason: 'expired' }
  | { readonly reason: 'revoked' }
  | { readonly reason: 'unavailable' };

export interface LogoutFailure {
  readonly reason: 'unavailable';
}

export type MeResponse =
  | {
      readonly kind: 'membership';
      readonly id: string;
      readonly email: string;
      readonly role: MembershipRole;
      readonly company: { readonly id: string; readonly name: string; readonly slug: string };
    }
  | { readonly kind: 'platform'; readonly id: string; readonly email: string };

type AuthMetrics = Pick<Metrics, 'countAuthLogin' | 'countAuthRefresh' | 'countAuthLogout'>;

export interface AuthServiceDeps {
  readonly companies: CompanyRepository;
  readonly memberships: MembershipRepository;
  readonly platformAdmins: PlatformAdminRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: AccessTokenService;
  readonly sessions: SessionStore;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: AuthMetrics | undefined;
  /**
   * Chave do HMAC do contador de falhas de login (derivada do `JWT_SECRET` com rótulo fixo, ver
   * `deriveLoginLockSecret`). O e-mail é dado pessoal de baixa entropia: um SHA-256 simples da
   * chave do Redis permitiria testar candidatos offline; com o HMAC isso exige o segredo.
   */
  readonly loginLockSecret: string | Buffer;
  /**
   * Segundo fator do administrador da plataforma (spec 044, E1). Presente (`PLATFORM_ADMIN_ENABLED=true`),
   * `POST /auth/platform/login` também exige o código e a entrada pelo cookie do admin existe.
   */
  readonly platformSecondFactor?: PlatformSecondFactor | undefined;
}

/** Administrador conferido por senha e segundo fator (spec 044), sem sessão criada. */
export interface VerifiedPlatformAdmin {
  readonly adminId: PlatformAdminId;
  readonly totpSecretCiphertext: string;
}

/** Chave do HMAC do contador de login: HMAC do segredo do JWT com um rótulo fixo (separação de domínio). */
export function deriveLoginLockSecret(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('soprei:auth:login-lock:v1').digest();
}

const REFRESH_SECRET_PATTERN = /^[A-Za-z0-9_-]{64}$/;

interface ParsedRefresh {
  readonly scope: string;
  readonly sessionId: string;
  readonly secret: string;
}

/** `<escopo>.<sessionId>.<segredo>`; qualquer outra forma é inválida. Escopo e sessão não são autoridade. */
export function parseRefreshToken(value: string): ParsedRefresh | undefined {
  if (value.length > 256) return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [scope, sessionId, secret] = parts as [string, string, string];
  if (scope !== PLATFORM_SCOPE && !isUuid(scope)) return undefined;
  if (!isUuid(sessionId) || !REFRESH_SECRET_PATTERN.test(secret)) return undefined;
  return { scope: scope.toLowerCase(), sessionId: sessionId.toLowerCase(), secret };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Identidade do pedido para o bloqueio por conta (exceção declarada à regra "chave deriva do
 * `CompanyId`": vale antes de existir `CompanyId` e também para contas inexistentes). Só o hash sai
 * daqui; o prefixo `c`/`p` impede colisão entre uma empresa de slug `platform` e o administrador.
 */
export function loginLockKey(secret: string | Buffer, parts: readonly string[]): string {
  return createHmac('sha256', secret).update(parts.join('\u0000')).digest('hex');
}

interface LoginAccount {
  readonly passwordHash: string;
  readonly active: boolean;
  readonly identity: MembershipIdentity | PlatformIdentity;
  /** Só do administrador da plataforma (spec 044). */
  readonly totpSecretCiphertext?: string | null;
}

/** Conferência extra depois da senha certa (o segundo fator); `false` vira a mesma falha de credencial. */
type ExtraCheck = (account: LoginAccount) => Promise<boolean>;

/**
 * Login, renovação, logout e verificação de access token (spec 007). Os erros esperados voltam
 * como `Result`; o que é bug ou falha de banco sobe como exceção. **Nunca** loga senha, hash,
 * token, e-mail nem slug: só ids e resultados.
 */
export class AuthService {
  private readonly companies: CompanyRepository;
  private readonly memberships: MembershipRepository;
  private readonly platformAdmins: PlatformAdminRepository;
  private readonly hasher: PasswordHasher;
  private readonly tokens: AccessTokenService;
  private readonly sessions: SessionStore;
  private readonly logger: FastifyBaseLogger;
  private readonly metrics: AuthMetrics | undefined;
  private readonly loginLockSecret: string | Buffer;
  private readonly platformSecondFactor: PlatformSecondFactor | undefined;

  constructor(deps: AuthServiceDeps) {
    this.platformSecondFactor = deps.platformSecondFactor;
    this.loginLockSecret = deps.loginLockSecret;
    this.companies = deps.companies;
    this.memberships = deps.memberships;
    this.platformAdmins = deps.platformAdmins;
    this.hasher = deps.hasher;
    this.tokens = deps.tokens;
    this.sessions = deps.sessions;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
  }

  /** Login de usuário de uma empresa: `companySlug` + e-mail (já normalizado) + senha (já normalizada). */
  login(input: {
    readonly companySlug: string;
    readonly email: string;
    readonly password: string;
  }): Promise<Result<AuthTokens, LoginFailure>> {
    return this.loginFlow(
      'membership',
      loginLockKey(this.loginLockSecret, ['c', input.companySlug, input.email]),
      input.password,
      async () => {
        const company = await this.findCompany(input.companySlug);
        if (company?.status !== 'ACTIVE') return undefined;
        const found = await this.memberships.findCredentialsByEmail(company.id, input.email);
        if (found === null) return undefined;
        return {
          passwordHash: found.passwordHash,
          active: found.membership.status === 'ACTIVE',
          identity: {
            kind: 'membership',
            membershipId: found.membership.id,
            companyId: company.id,
            role: found.membership.role,
            sessionId: '',
          },
        };
      },
    );
  }

  /**
   * Login Bearer de operador da plataforma. Com o segundo fator ligado (spec 044), `code` é exigido:
   * ausente ou errado, a mesma 401 de senha errada (e o `verify` da senha roda uma vez do mesmo jeito).
   */
  loginPlatform(input: {
    readonly email: string;
    readonly password: string;
    readonly code?: string | undefined;
  }): Promise<Result<AuthTokens, LoginFailure>> {
    return this.loginFlow(
      'platform',
      loginLockKey(this.loginLockSecret, ['p', input.email]),
      input.password,
      () => this.lookupPlatformAdmin(input.email),
      this.platformSecondFactor === undefined ? undefined : this.secondFactorCheck(input.code),
    );
  }

  /**
   * Confere senha e segundo fator do administrador da plataforma **sem** criar sessão Bearer (a entrada
   * pelo cookie do admin, spec 044). Mesmo bloqueio por conta, mesma falha uniforme e o `verify` da
   * senha uma vez em todos os caminhos.
   */
  async verifyPlatformCredentials(input: {
    readonly email: string;
    readonly password: string;
    readonly code: string;
  }): Promise<Result<VerifiedPlatformAdmin, LoginFailure>> {
    // Sem segundo fator configurado a entrada pelo cookie não existe; nunca entra só com a senha.
    if (this.platformSecondFactor === undefined) return Result.err({ reason: 'unavailable' });
    const checked = await this.checkCredentials(
      'platform',
      loginLockKey(this.loginLockSecret, ['p', input.email]),
      input.password,
      () => this.lookupPlatformAdmin(input.email),
      this.secondFactorCheck(input.code),
    );
    if (!checked.ok) return checked;
    const { identity, totpSecretCiphertext } = checked.value;
    if (
      identity.kind !== 'platform' ||
      totpSecretCiphertext === undefined ||
      totpSecretCiphertext === null
    ) {
      return Result.err({ reason: 'invalid_credentials' });
    }
    this.metrics?.countAuthLogin('platform', 'ok');
    return Result.ok({ adminId: identity.adminId, totpSecretCiphertext });
  }

  private async lookupPlatformAdmin(email: string): Promise<LoginAccount | undefined> {
    const found = await this.platformAdmins.findCredentialsByEmail(email);
    if (found === null) return undefined;
    return {
      passwordHash: found.passwordHash,
      active: found.admin.status === 'ACTIVE',
      identity: { kind: 'platform', adminId: found.admin.id, sessionId: '' },
      totpSecretCiphertext: found.totpSecretCiphertext,
    };
  }

  private secondFactorCheck(code: string | undefined): ExtraCheck {
    return async (account) => {
      if (account.identity.kind !== 'platform' || this.platformSecondFactor === undefined) {
        return false;
      }
      return this.platformSecondFactor.verify(
        account.identity.adminId,
        account.totpSecretCiphertext ?? null,
        code,
      );
    };
  }

  async refresh(refreshToken: string): Promise<Result<AuthTokens, RefreshFailure>> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed === undefined) {
      this.metrics?.countAuthRefresh('invalid');
      return Result.err({ reason: 'invalid_refresh' });
    }
    const { scope, sessionId, secret } = parsed;
    try {
      const newSecret = randomBytes(48).toString('base64url');
      const outcome = await this.sessions.rotate({
        scope,
        sessionId,
        presentedHash: sha256Hex(secret),
        newHash: sha256Hex(newSecret),
      });
      if (outcome.status === 'invalid') {
        this.metrics?.countAuthRefresh('invalid');
        return Result.err({ reason: 'invalid_refresh' });
      }
      if (outcome.status === 'reuse') {
        this.metrics?.countAuthRefresh('reuse');
        this.logger.warn(
          { sessionId, subjectId: outcome.subjectId, scope },
          'reuso de refresh token detectado: sessão revogada',
        );
        return Result.err({ reason: 'reuse_detected' });
      }
      const identity = await this.resolveIdentity(scope, outcome.subjectId, sessionId);
      if (identity === undefined) {
        // Usuário desativado, empresa suspensa ou removido: a sessão não continua.
        await this.sessions.revokeSession(scope, sessionId);
        this.metrics?.countAuthRefresh('invalid');
        return Result.err({ reason: 'invalid_refresh' });
      }
      const access = await this.tokens.issue(identity);
      this.metrics?.countAuthRefresh('ok');
      this.logger.info({ sessionId, subjectId: outcome.subjectId, scope }, 'sessão renovada');
      return Result.ok({
        accessToken: access.token,
        refreshToken: `${scope}.${sessionId}.${newSecret}`,
        tokenType: 'Bearer',
        expiresIn: access.expiresIn,
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        this.metrics?.countAuthRefresh('unavailable');
        return Result.err({ reason: 'unavailable' });
      }
      throw error;
    }
  }

  /** Revoga a sessão do refresh. Idempotente: refresh desconhecido ou malformado também é sucesso. */
  async logout(refreshToken: string): Promise<Result<void, LogoutFailure>> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed === undefined) return Result.ok(undefined);
    try {
      const revoked = await this.sessions.revokeByRefresh({
        scope: parsed.scope,
        sessionId: parsed.sessionId,
        presentedHash: sha256Hex(parsed.secret),
      });
      if (revoked) {
        this.metrics?.countAuthLogout('session');
        this.logger.info({ sessionId: parsed.sessionId, scope: parsed.scope }, 'logout');
      }
      return Result.ok(undefined);
    } catch (error) {
      if (error instanceof ServiceUnavailableError) return Result.err({ reason: 'unavailable' });
      throw error;
    }
  }

  async logoutAll(identity: AuthIdentity): Promise<Result<void, LogoutFailure>> {
    try {
      await this.sessions.revokeAllSessions(scopeOf(identity), subjectIdOf(identity));
      this.metrics?.countAuthLogout('all');
      this.logger.info(
        { sessionId: identity.sessionId, subjectId: subjectIdOf(identity) },
        'logout de todas as sessões',
      );
      return Result.ok(undefined);
    } catch (error) {
      if (error instanceof ServiceUnavailableError) return Result.err({ reason: 'unavailable' });
      throw error;
    }
  }

  /** Verifica assinatura e claims e consulta a revogação. Redis fora: `unavailable` (fail-closed). */
  async authenticate(token: string): Promise<Result<AuthIdentity, AuthenticateFailure>> {
    const verified = await this.tokens.verify(token);
    if (!verified.ok) return Result.err({ reason: verified.error });
    const { identity, issuedAt } = verified.value;
    try {
      const check = await this.sessions.checkAccess({
        scope: scopeOf(identity),
        sessionId: identity.sessionId,
        subjectId: subjectIdOf(identity),
        issuedAt,
      });
      if (check === 'revoked') return Result.err({ reason: 'revoked' });
      return Result.ok(identity);
    } catch (error) {
      if (error instanceof ServiceUnavailableError) return Result.err({ reason: 'unavailable' });
      throw error;
    }
  }

  /** Identidade do token, lida do banco (nunca devolve o hash). */
  async me(identity: AuthIdentity): Promise<MeResponse> {
    try {
      if (identity.kind === 'platform') {
        const admin = await this.platformAdmins.findById(identity.adminId);
        return { kind: 'platform', id: admin.id, email: admin.email };
      }
      const [membership, company] = await Promise.all([
        this.memberships.findById(identity.companyId, identity.membershipId),
        this.companies.findById(identity.companyId),
      ]);
      return {
        kind: 'membership',
        id: membership.id,
        email: membership.email,
        role: membership.role,
        company: { id: company.id, name: company.name, slug: company.slug },
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw new UnauthorizedError();
      throw error;
    }
  }

  private async findCompany(slug: string): Promise<Company | undefined> {
    try {
      return await this.companies.findBySlug(slug);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  /** Confere as credenciais (`checkCredentials`) e cria a sessão Bearer. */
  private async loginFlow(
    kind: 'membership' | 'platform',
    lockKey: string,
    password: string,
    lookup: () => Promise<LoginAccount | undefined>,
    extraCheck?: ExtraCheck,
  ): Promise<Result<AuthTokens, LoginFailure>> {
    const checked = await this.checkCredentials(kind, lockKey, password, lookup, extraCheck);
    if (!checked.ok) return checked;
    const account = checked.value;
    try {
      const sessionId = randomUUID();
      const secret = randomBytes(48).toString('base64url');
      const identity: AuthIdentity = { ...account.identity, sessionId };
      const scope = scopeOf(identity);
      await this.sessions.createSession({
        scope,
        sessionId,
        subjectId: subjectIdOf(identity),
        refreshHash: sha256Hex(secret),
      });
      const access = await this.tokens.issue(identity);
      this.metrics?.countAuthLogin(kind, 'ok');
      this.logger.info(
        {
          kind,
          sessionId,
          subjectId: subjectIdOf(identity),
          ...(identity.kind === 'membership' ? { companyId: identity.companyId } : {}),
        },
        'login ok',
      );
      return Result.ok({
        accessToken: access.token,
        refreshToken: `${scope}.${sessionId}.${secret}`,
        tokenType: 'Bearer',
        expiresIn: access.expiresIn,
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableError) return Result.err({ reason: 'unavailable' });
      throw error;
    }
  }

  /**
   * Bloqueio, conta e senha (e a conferência extra, se houver), sem criar sessão. O mesmo trabalho em
   * todos os caminhos: com ou sem conta, o `verify` roda **uma vez** (contra um hash fictício quando não
   * há conta); a conferência extra só roda depois da senha certa. Bloqueada, a conta responde 429
   * antes de gastar hash.
   */
  private async checkCredentials(
    kind: 'membership' | 'platform',
    lockKey: string,
    password: string,
    lookup: () => Promise<LoginAccount | undefined>,
    extraCheck?: ExtraCheck,
  ): Promise<Result<LoginAccount, LoginFailure>> {
    try {
      const lock = await this.sessions.loginLockState(lockKey);
      if (lock.locked) {
        this.metrics?.countAuthLogin(kind, 'locked');
        this.logger.warn({ kind }, 'login bloqueado por excesso de falhas na conta');
        return Result.err({ reason: 'locked', retryAfterSeconds: lock.retryAfterSeconds });
      }

      const account = await lookup();
      const storedHash = account?.passwordHash ?? (await this.hasher.dummyHash());
      const matches = await this.hasher.verify(password, storedHash);
      const accepted =
        account !== undefined &&
        account.active &&
        matches &&
        (extraCheck === undefined || (await extraCheck(account)));
      if (!accepted) {
        await this.sessions.recordLoginFailure(lockKey);
        this.metrics?.countAuthLogin(kind, 'invalid');
        this.logger.info({ kind, result: 'invalid' }, 'login recusado');
        return Result.err({ reason: 'invalid_credentials' });
      }
      await this.sessions.resetLoginFailures(lockKey);
      return Result.ok(account);
    } catch (error) {
      if (error instanceof ServiceUnavailableError) return Result.err({ reason: 'unavailable' });
      throw error;
    }
  }

  /** Quem a sessão representa agora (papel atual do banco), ou `undefined` se não vale mais. */
  private async resolveIdentity(
    scope: string,
    subjectId: string,
    sessionId: string,
  ): Promise<AuthIdentity | undefined> {
    try {
      if (scope === PLATFORM_SCOPE) {
        const admin = await this.platformAdmins.findById(PlatformAdminId.parse(subjectId));
        if (admin.status !== 'ACTIVE') return undefined;
        return { kind: 'platform', adminId: admin.id, sessionId };
      }
      const companyId = CompanyId.parse(scope);
      const [company, membership] = await Promise.all([
        this.companies.findById(companyId),
        this.memberships.findById(companyId, MembershipId.parse(subjectId)),
      ]);
      if (company.status !== 'ACTIVE' || membership.status !== 'ACTIVE') return undefined;
      return {
        kind: 'membership',
        membershipId: membership.id,
        companyId,
        role: membership.role,
        sessionId,
      };
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}
