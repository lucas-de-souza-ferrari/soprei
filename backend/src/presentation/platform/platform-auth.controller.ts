import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import {
  ForbiddenError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { setActorId } from '../../shared/request-context/index.js';
import { requestAuth, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { platformSessionLoginBodySchema } from '../auth/auth.validators.js';

/**
 * Cookie da sessão do admin da plataforma (spec 044, E1). O prefixo `__Host-` obriga o navegador a
 * aceitá-lo só com `Secure`, `Path=/` e sem `Domain`: ele fica preso ao hostname do admin e nunca vai ao
 * site das empresas.
 */
export const PLATFORM_COOKIE = '__Host-soprei_platform';
/** Cabeçalho exigido em toda escrita do admin (junto com `Origin = ADMIN_ORIGIN`). */
export const PLATFORM_APP_HEADER_VALUE = 'admin';

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_CREDENTIALS = 'Credenciais inválidas';

/** O segredo do cookie do admin, ou `undefined` (ausente, repetido ou malformado). */
export function platformCookieSecret(header: string | undefined): string | undefined {
  const matches = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PLATFORM_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const secret = matches[0]?.slice(PLATFORM_COOKIE.length + 1) ?? '';
  return SECRET_PATTERN.test(secret) ? secret : undefined;
}

export interface PlatformAuthControllerOptions {
  readonly auth: Pick<PlatformAuthService, 'login' | 'logout' | 'authenticate' | 'me'>;
  /** `ADMIN_ORIGIN`: a única origem aceita nas escritas. */
  readonly origin: string;
  /** Teto absoluto da sessão (`PLATFORM_SESSION_MAX_SECONDS`), usado como `Max-Age` do cookie. */
  readonly maxAgeSeconds: number;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${PLATFORM_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${String(maxAgeSeconds)}`;
}

function clearCookie(reply: FastifyReply): void {
  void reply.header('set-cookie', sessionCookie('', 0));
}

/**
 * Rotas `/platform/auth/*` (registre com `prefix: '/platform'`). Só o cookie do admin vale aqui: o
 * `Authorization` é ignorado (o Bearer não passa pelo segundo fator) e o cookie da conta do site nunca é
 * lido. Toda escrita exige `Origin = ADMIN_ORIGIN` e `X-Soprei-App: admin`.
 */
export const platformAuthController: FastifyPluginCallback<PlatformAuthControllerOptions> = (
  app,
  { auth, origin, maxAgeSeconds },
  done,
) => {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header('cache-control', 'no-store');
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      (request.headers.origin !== origin ||
        request.headers['x-soprei-app'] !== PLATFORM_APP_HEADER_VALUE)
    ) {
      throw new ForbiddenError('Origem inválida');
    }
    // Nenhuma outra identidade entra aqui, nem a que um hook da raiz tenha preenchido.
    request.auth = null;
    const secret = platformCookieSecret(request.headers.cookie);
    if (secret === undefined) return;
    const identity = await auth.authenticate(secret);
    if (identity === undefined) return;
    request.auth = identity;
    setActorId(identity.adminId);
  });

  const login = { config: rateLimitProfile('login') };
  const admin = { config: rateLimitProfile('admin') };

  app.post('/auth/login', login, async (request, reply) => {
    const body = platformSessionLoginBodySchema.parse(request.body);
    const result = await auth.login(body);
    if (!result.ok) {
      switch (result.error.reason) {
        case 'invalid_credentials':
          throw new UnauthorizedError(INVALID_CREDENTIALS);
        case 'locked':
          throw new RateLimitError(result.error.retryAfterSeconds);
        case 'unavailable':
          throw new ServiceUnavailableError('Serviço de autenticação indisponível');
      }
    }
    void reply.header('set-cookie', sessionCookie(result.value.secret, maxAgeSeconds));
    return reply.status(204).send();
  });

  app.post('/auth/logout', login, async (request, reply) => {
    const secret = platformCookieSecret(request.headers.cookie);
    if (secret !== undefined) await auth.logout(secret);
    clearCookie(reply);
    return reply.status(204).send();
  });

  app.get('/auth/session', { ...admin, onRequest: requirePlatform() }, async (request) => {
    const identity = requestAuth(request);
    if (identity.kind !== 'platform') throw new UnauthorizedError();
    return auth.me(identity);
  });

  done();
};
