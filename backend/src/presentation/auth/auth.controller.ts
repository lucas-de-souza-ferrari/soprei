import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import type {
  AuthService,
  AuthTokens,
  LoginFailure,
  RefreshFailure,
} from '../../application/auth/auth.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import type { MembershipAdminService } from '../../application/memberships/membership-admin.service.js';
import {
  authenticateHook,
  requestAuth,
  requireMembership,
  membershipAuth,
} from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  changePasswordBodySchema,
  loginBodySchema,
  platformLoginBodySchema,
  refreshBodySchema,
} from './auth.validators.js';

export interface AuthControllerOptions {
  readonly browserAccounts?: boolean;
  readonly auth: AuthService;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection'> | undefined;
  /** Troca da própria senha (spec 008). Sem isto `POST /auth/password` não existe. */
  readonly membershipAdmin?: Pick<MembershipAdminService, 'changeOwnPassword'>;
}

const INVALID_CREDENTIALS = 'Credenciais inválidas';
const INVALID_SESSION = 'Sessão inválida';

/** Resposta com tokens: nunca em cache de navegador ou proxy. */
function sendTokens(reply: FastifyReply, tokens: AuthTokens): FastifyReply {
  void reply.header('cache-control', 'no-store');
  void reply.header('pragma', 'no-cache');
  return reply.status(200).send({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresIn: tokens.expiresIn,
  });
}

/** Falha esperada do login vira erro da hierarquia: a mesma 401 (mensagem fixa) para todas as recusas. */
function loginError(failure: LoginFailure): Error {
  switch (failure.reason) {
    case 'invalid_credentials':
      return new UnauthorizedError(INVALID_CREDENTIALS);
    case 'locked':
      return new RateLimitError(failure.retryAfterSeconds);
    case 'unavailable':
      return new ServiceUnavailableError('Serviço de autenticação indisponível');
  }
}

function refreshError(failure: RefreshFailure): Error {
  switch (failure.reason) {
    // Reuso e refresh inválido têm a mesma resposta: quem não é o dono não aprende nada.
    case 'invalid_refresh':
    case 'reuse_detected':
      return new UnauthorizedError(INVALID_SESSION);
    case 'unavailable':
      return new ServiceUnavailableError('Serviço de autenticação indisponível');
  }
}

/**
 * Rotas `/auth/*` (spec 007; registre com `prefix: '/auth'`). Finas: validam com Zod, chamam o
 * `AuthService` e traduzem a falha esperada em erro da hierarquia. Nunca logam senha, e-mail nem
 * token.
 */
export const authController: FastifyPluginCallback<AuthControllerOptions> = (
  app,
  { auth, metrics, membershipAdmin, browserAccounts = false },
  done,
) => {
  const authenticate = authenticateHook({ auth, metrics });
  const loginConfig = rateLimitProfile('login');
  const refreshConfig = rateLimitProfile('refresh');
  const adminConfig = rateLimitProfile('admin');

  if (!browserAccounts)
    app.post('/login', { config: loginConfig }, async (request, reply) => {
      const body = loginBodySchema.parse(request.body);
      const result = await auth.login(body);
      if (!result.ok) throw loginError(result.error);
      return sendTokens(reply, result.value);
    });

  app.post('/platform/login', { config: loginConfig }, async (request, reply) => {
    const body = platformLoginBodySchema.parse(request.body);
    const result = await auth.loginPlatform(body);
    if (!result.ok) throw loginError(result.error);
    return sendTokens(reply, result.value);
  });

  app.post('/refresh', { config: refreshConfig }, async (request, reply) => {
    const { refreshToken } = refreshBodySchema.parse(request.body);
    const result = await auth.refresh(refreshToken);
    if (!result.ok) throw refreshError(result.error);
    return sendTokens(reply, result.value);
  });

  if (!browserAccounts)
    app.post('/logout', { config: refreshConfig }, async (request, reply) => {
      const { refreshToken } = refreshBodySchema.parse(request.body);
      const result = await auth.logout(refreshToken);
      if (!result.ok) throw new ServiceUnavailableError('Serviço de autenticação indisponível');
      return reply.status(204).send();
    });

  app.post(
    '/logout-all',
    { config: adminConfig, onRequest: authenticate },
    async (request, reply) => {
      const result = await auth.logoutAll(requestAuth(request));
      if (!result.ok) throw new ServiceUnavailableError('Serviço de autenticação indisponível');
      return reply.status(204).send();
    },
  );

  if (membershipAdmin !== undefined) {
    // Perfil `login` (fail-closed: sem o Redis do limiter, 503 sem verificar a senha). Qualquer
    // `Membership` autenticado troca a própria senha; `PlatformAdmin` recebe 403. Responde 204 e derruba
    // todas as sessões da pessoa, inclusive a atual: ela faz login de novo.
    app.post(
      '/password',
      { config: loginConfig, onRequest: [authenticate, requireMembership()] },
      async (request, reply) => {
        const body = changePasswordBodySchema.parse(request.body);
        await membershipAdmin.changeOwnPassword(membershipAuth(request), body);
        return reply.status(204).send();
      },
    );
  }

  app.get('/me', { config: adminConfig, onRequest: authenticate }, async (request) =>
    auth.me(requestAuth(request)),
  );

  done();
};
