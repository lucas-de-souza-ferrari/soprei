import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../../application/auth/account.service.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import {
  emailSchema,
  loginPasswordSchema,
  newPasswordSchema,
} from '../../application/auth/credentials.js';
import {
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { rateLimitProfile } from '../common/rate-limit.js';

export const ACCOUNT_COOKIE = 'soprei_session';
export function accountCookie(header: string | undefined): string {
  const matches = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ACCOUNT_COOKIE}=`));
  if (matches.length !== 1) throw new UnauthorizedError();
  const secret = matches[0]?.slice(ACCOUNT_COOKIE.length + 1) ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new UnauthorizedError();
  return secret;
}

export const accountController: FastifyPluginCallback<{
  service: AccountService;
  legacyAuth?: Pick<AuthService, 'logout'>;
  origin: string;
  secure: boolean;
}> = (app, { service, origin, secure, legacyAuth }, done) => {
  const cookie = (value: string, clear = false): string =>
    `${ACCOUNT_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 30 * 86400}${secure ? '; Secure' : ''}`;
  const credentials = z.object({ email: emailSchema, password: loginPasswordSchema }).strict();
  const registration = z.object({ email: emailSchema, password: newPasswordSchema }).strict();
  const verification = credentials.extend({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
  app.addHook('onRequest', (request, reply, next) => {
    void reply.header('cache-control', 'no-store');
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.routeOptions.url !== '/auth/logout' &&
      (request.headers.origin !== origin || request.headers['x-soprei-client'] !== 'web')
    ) {
      next(new ForbiddenError('Origem inválida'));
      return;
    }
    next();
  });
  const login = { config: rateLimitProfile('login') };
  const admin = { config: rateLimitProfile('admin') };
  app.post('/auth/register', login, async (request, reply) => {
    const body = registration.parse(request.body);
    await service.register(body.email, body.password);
    return reply
      .status(202)
      .send({ message: 'Se o cadastro puder ser realizado, confira seu e-mail.' });
  });
  app.post('/auth/resend-verification', login, async (request, reply) => {
    const body = credentials.parse(request.body);
    await service.resend(body.email, body.password);
    return reply.status(202).send({ message: 'Confira seu e-mail.' });
  });
  app.post('/auth/verify-email', login, async (request, reply) => {
    const body = verification.parse(request.body);
    await service.verify(body.email, body.password, body.token);
    return reply.status(204).send();
  });
  app.post('/auth/login', login, async (request, reply) => {
    const body = credentials.parse(request.body);
    const secret = await service.login(body.email, body.password);
    return reply.header('set-cookie', cookie(secret)).status(204).send();
  });
  app.post('/auth/logout', { config: rateLimitProfile('refresh') }, async (request, reply) => {
    // O operador da plataforma ainda usa refresh no corpo, sem depender de cookie/origem.
    const legacy = z
      .object({ refreshToken: z.string().min(1).max(512) })
      .strict()
      .safeParse(request.body);
    if (legacy.success && legacyAuth !== undefined) {
      const result = await legacyAuth.logout(legacy.data.refreshToken);
      if (!result.ok) throw new ServiceUnavailableError('Sessão indisponível');
      return reply.status(204).send();
    }
    if (request.headers.origin !== origin || request.headers['x-soprei-client'] !== 'web')
      throw new ForbiddenError('Origem inválida');
    void reply.header('set-cookie', cookie('', true));
    try {
      await service.logout(accountCookie(request.headers.cookie));
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }
    return reply.status(204).send();
  });
  // Leituras não reemitem cookies: uma resposta tardia não sobrescreve login/logout posterior.
  // O cookie tem o teto absoluto; o Redis aplica a inatividade de 7 dias.
  app.get('/auth/session', admin, (request) => service.me(accountCookie(request.headers.cookie)));
  app.get('/account/companies', admin, async (request) => ({
    items: await service.companies(accountCookie(request.headers.cookie)),
  }));
  app.post('/account/companies', admin, async (request, reply) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(200) })
      .strict()
      .parse(request.body);
    const result = await service.createCompany(accountCookie(request.headers.cookie), name);
    return reply.status(201).send(result);
  });
  app.post('/account/companies/:clientId/select', admin, async (request, reply) => {
    const { clientId } = z.object({ clientId: z.uuid() }).parse(request.params);
    await service.selectCompany(accountCookie(request.headers.cookie), clientId);
    return reply.status(204).send();
  });
  done();
};
