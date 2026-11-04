import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import {
  type AuthIdentity,
  subjectIdOf,
  type MembershipIdentity,
} from '../../application/auth/identity.js';
import { hasPermission, type Permission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { setCompanyId, setActorId } from '../../shared/request-context/index.js';
import { routePattern } from './route-pattern.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Identidade autenticada (spec 007), preenchida pelo hook `authenticate` a partir do access
     * token **assinado**. É a única fonte do `CompanyId` das rotas de tenant.
     */
    auth: AuthIdentity | null;
  }
}

/** Marca (para o teste de inventário) de qual espécie de identidade o hook da rota exige. */
export const REQUIRED_AUTH_KIND = Symbol.for('soprei.requiredAuthKind');

type AuthenticateMetrics = Pick<Metrics, 'countAuthTokenRejection'>;

export interface AuthenticateHookParams {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: AuthenticateMetrics | undefined;
}

/** RFC 6750 (`token68`): o que um Bearer pode conter. */
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

type Rejection = 'missing' | 'malformed' | 'invalid' | 'expired' | 'revoked';

/**
 * Hook `authenticate` (spec 007): valida o access token de `Authorization: Bearer`, preenche
 * `request.auth` e o contexto de log (`membershipId`, `companyId`). A resposta à empresa é sempre a
 * mesma 401, com `WWW-Authenticate: Bearer` e mensagem constante: o motivo (categoria) vai só à
 * métrica e ao log, nunca o token. Redis fora: 503 (fail-closed, nunca aceita sem checar a
 * revogação). Registre-o em cada plugin de rotas autenticadas, antes dos hooks `require*`.
 */
export function authenticateHook({
  auth,
  metrics,
}: AuthenticateHookParams): onRequestAsyncHookHandler {
  const countRejection = (request: FastifyRequest, reason: Rejection | 'unavailable'): void => {
    try {
      metrics?.countAuthTokenRejection(reason);
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao registrar métrica de autenticação');
    }
  };
  const reject = (request: FastifyRequest, reply: FastifyReply, reason: Rejection): never => {
    countRejection(request, reason);
    request.log.warn({ route: routePattern(request), reason }, 'autenticação recusada');
    void reply.header('www-authenticate', 'Bearer');
    throw new UnauthorizedError();
  };

  return async (request, reply) => {
    // Preenchida apenas pelo hook de sessão server-side, após reler conta e vínculo no banco.
    if (request.auth !== null) {
      setActorId(subjectIdOf(request.auth));
      if (request.auth.kind === 'membership') setCompanyId(request.auth.companyId);
      return;
    }
    const header = request.headers.authorization;
    if (header === undefined) return reject(request, reply, 'missing');
    const token = BEARER.exec(header)?.[1];
    if (token === undefined || token.split('.').length !== 3) {
      return reject(request, reply, 'malformed');
    }
    const result = await auth.authenticate(token);
    if (!result.ok) {
      if (result.error.reason === 'unavailable') {
        countRejection(request, 'unavailable');
        request.log.error(
          { route: routePattern(request) },
          'autenticação indisponível (fail-closed)',
        );
        throw new ServiceUnavailableError('Serviço de autenticação indisponível');
      }
      return reject(request, reply, result.error.reason);
    }
    request.auth = result.value;
    setActorId(subjectIdOf(result.value));
    if (result.value.kind === 'membership') setCompanyId(result.value.companyId);
  };
}

/** Marca (para o teste de inventário) de qual permissão o hook `requirePermission` da rota exige. */
export const REQUIRED_PERMISSION = Symbol.for('soprei.requiredPermission');

function tagged(
  kind: 'membership' | 'platform',
  handler: onRequestAsyncHookHandler,
): onRequestAsyncHookHandler {
  return Object.assign(handler, { [REQUIRED_AUTH_KIND]: kind });
}

/** Adapta uma checagem síncrona (que lança) ao formato assíncrono dos hooks do Fastify. */
function asHook(check: (request: FastifyRequest) => void): onRequestAsyncHookHandler {
  return (request) => {
    try {
      check(request);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  };
}

/**
 * As checagens de `requireMembership`, em ordem: 401 (sem identidade) -> 403 (`PlatformAdmin`) -> 404
 * (`:companyId` do caminho diverge do token). Devolve a identidade do `Membership`.
 */
function checkMembership(
  request: FastifyRequest,
  companyParam: string | undefined,
): MembershipIdentity {
  const auth = request.auth;
  if (auth === null) throw new UnauthorizedError();
  if (auth.kind !== 'membership') throw new ForbiddenError();
  if (companyParam !== undefined) {
    const params = request.params as Readonly<Record<string, unknown>> | undefined;
    const fromPath = params?.[companyParam];
    if (typeof fromPath !== 'string' || fromPath.toLowerCase() !== auth.companyId) {
      throw new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
    }
  }
  return auth;
}

/**
 * RBAC mínimo da spec 007: a rota exige um `Membership` (de tenant). `PlatformAdmin` recebe 403. Com
 * `companyParam`, o parâmetro de caminho daquele nome é **conferido** contra o `CompanyId` do token:
 * divergência é 404 `NOT_FOUND`, idêntico a empresa inexistente (não revela quais ids existem).
 * Depois da conferência, use `request.auth.companyId` e descarte o parâmetro.
 */
export function requireMembership(
  options: { readonly companyParam?: string } = {},
): onRequestAsyncHookHandler {
  return tagged(
    'membership',
    asHook((request) => {
      checkMembership(request, options.companyParam);
    }),
  );
}

export interface RequirePermissionOptions {
  /** Como em `requireMembership`: o parâmetro de caminho conferido contra o `CompanyId` do token. */
  readonly companyParam?: string;
  /** Conta a negação em `authz_denials_total{permission}`. */
  readonly metrics?: Pick<Metrics, 'countAuthzDenial'> | undefined;
}

/**
 * RBAC (spec 008): a rota exige a **permissão** (nunca um papel). Construído sobre `requireMembership`
 * (mesmas checagens e mesma marca, então o inventário de rotas o reconhece): 401 -> 403
 * (`PlatformAdmin`) -> 404 (`:companyId` divergente: vem **antes** da permissão, para não revelar a
 * existência de uma empresa a quem não é dele) -> 403 se o papel do token não tem a permissão. O
 * `CompanyId` continua vindo só do token. A negação vira métrica (conjunto fixo) e log `warn` só
 * com padrão de rota, permissão e papel (os ids vão pelo contexto; nunca e-mail).
 */
export function requirePermission(
  permission: Permission,
  options: RequirePermissionOptions = {},
): onRequestAsyncHookHandler {
  const handler = tagged(
    'membership',
    asHook((request) => {
      const auth = checkMembership(request, options.companyParam);
      if (hasPermission(auth.role, permission)) return;
      try {
        options.metrics?.countAuthzDenial(permission);
      } catch (error) {
        request.log.warn({ err: error }, 'falha ao registrar métrica de autorização');
      }
      request.log.warn(
        { route: routePattern(request), permission, role: auth.role },
        'permissão negada',
      );
      throw new ForbiddenError();
    }),
  );
  return Object.assign(handler, { [REQUIRED_PERMISSION]: permission });
}

/** A rota exige um `PlatformAdmin`. `Membership` recebe 403. */
export function requirePlatform(): onRequestAsyncHookHandler {
  return tagged('platform', (request) => {
    const auth = request.auth;
    if (auth === null) return Promise.reject(new UnauthorizedError());
    if (auth.kind !== 'platform') return Promise.reject(new ForbiddenError());
    return Promise.resolve();
  });
}

/** A identidade de `Membership` da requisição (o `CompanyId` do token). Só depois de `requireMembership()`. */
export function membershipAuth(request: FastifyRequest): MembershipIdentity {
  const auth = request.auth;
  if (auth?.kind !== 'membership') throw new UnauthorizedError();
  return auth;
}

/** A identidade autenticada, qualquer espécie. Só depois do hook `authenticate`. */
export function requestAuth(request: FastifyRequest): AuthIdentity {
  if (request.auth === null) throw new UnauthorizedError();
  return request.auth;
}
