import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import {
  type AuthIdentity,
  subjectIdOf,
  type UserIdentity,
} from '../../application/auth/identity.js';
import { hasPermission, type Permission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { setClientId, setUserId } from '../../shared/request-context/index.js';
import { routePattern } from './route-pattern.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Identidade autenticada (spec 007), preenchida pelo hook `authenticate` a partir do access
     * token **assinado**. É a única fonte do `ClientId` das rotas de tenant.
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
 * `request.auth` e o contexto de log (`userId`, `clientId`). A resposta ao cliente é sempre a
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
    setUserId(subjectIdOf(result.value));
    if (result.value.kind === 'user') setClientId(result.value.clientId);
  };
}

/** Marca (para o teste de inventário) de qual permissão o hook `requirePermission` da rota exige. */
export const REQUIRED_PERMISSION = Symbol.for('soprei.requiredPermission');

function tagged(
  kind: 'user' | 'platform',
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
 * As checagens de `requireUser`, em ordem: 401 (sem identidade) -> 403 (`PlatformAdmin`) -> 404
 * (`:clientId` do caminho diverge do token). Devolve a identidade do `User`.
 */
function checkUser(request: FastifyRequest, clientParam: string | undefined): UserIdentity {
  const auth = request.auth;
  if (auth === null) throw new UnauthorizedError();
  if (auth.kind !== 'user') throw new ForbiddenError();
  if (clientParam !== undefined) {
    const params = request.params as Readonly<Record<string, unknown>> | undefined;
    const fromPath = params?.[clientParam];
    if (typeof fromPath !== 'string' || fromPath.toLowerCase() !== auth.clientId) {
      throw new NotFoundError('Cliente não encontrado', { context: { entity: 'Client' } });
    }
  }
  return auth;
}

/**
 * RBAC mínimo da spec 007: a rota exige um `User` (de tenant). `PlatformAdmin` recebe 403. Com
 * `clientParam`, o parâmetro de caminho daquele nome é **conferido** contra o `ClientId` do token:
 * divergência é 404 `NOT_FOUND`, idêntico a cliente inexistente (não revela quais ids existem).
 * Depois da conferência, use `request.auth.clientId` e descarte o parâmetro.
 */
export function requireUser(
  options: { readonly clientParam?: string } = {},
): onRequestAsyncHookHandler {
  return tagged(
    'user',
    asHook((request) => {
      checkUser(request, options.clientParam);
    }),
  );
}

export interface RequirePermissionOptions {
  /** Como em `requireUser`: o parâmetro de caminho conferido contra o `ClientId` do token. */
  readonly clientParam?: string;
  /** Conta a negação em `authz_denials_total{permission}`. */
  readonly metrics?: Pick<Metrics, 'countAuthzDenial'> | undefined;
}

/**
 * RBAC (spec 008): a rota exige a **permissão** (nunca um papel). Construído sobre `requireUser`
 * (mesmas checagens e mesma marca, então o inventário de rotas o reconhece): 401 -> 403
 * (`PlatformAdmin`) -> 404 (`:clientId` divergente: vem **antes** da permissão, para não revelar a
 * existência de um cliente a quem não é dele) -> 403 se o papel do token não tem a permissão. O
 * `ClientId` continua vindo só do token. A negação vira métrica (conjunto fixo) e log `warn` só
 * com padrão de rota, permissão e papel (os ids vão pelo contexto; nunca e-mail).
 */
export function requirePermission(
  permission: Permission,
  options: RequirePermissionOptions = {},
): onRequestAsyncHookHandler {
  const handler = tagged(
    'user',
    asHook((request) => {
      const auth = checkUser(request, options.clientParam);
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

/** A rota exige um `PlatformAdmin`. `User` recebe 403. */
export function requirePlatform(): onRequestAsyncHookHandler {
  return tagged('platform', (request) => {
    const auth = request.auth;
    if (auth === null) return Promise.reject(new UnauthorizedError());
    if (auth.kind !== 'platform') return Promise.reject(new ForbiddenError());
    return Promise.resolve();
  });
}

/** A identidade de `User` da requisição (o `ClientId` do token). Só depois de `requireUser()`. */
export function userAuth(request: FastifyRequest): UserIdentity {
  const auth = request.auth;
  if (auth?.kind !== 'user') throw new UnauthorizedError();
  return auth;
}

/** A identidade autenticada, qualquer espécie. Só depois do hook `authenticate`. */
export function requestAuth(request: FastifyRequest): AuthIdentity {
  if (request.auth === null) throw new UnauthorizedError();
  return request.auth;
}
