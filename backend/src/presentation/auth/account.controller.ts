import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../../application/auth/account.service.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import {
  emailSchema,
  loginPasswordSchema,
  accountPasswordSchema,
} from '../../application/auth/credentials.js';
import {
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { VERIFICATION_CODE_PATTERN } from '../../application/auth/verification-code.js';
import { rateLimitProfile } from '../common/rate-limit.js';

/**
 * Corpo de `POST /auth/verify-email` (spec 020): o código são exatamente 6 dígitos. Formato inválido
 * é 400 antes de qualquer consulta e nunca conta como tentativa.
 */
export const verificationSchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema,
    code: z.string().regex(VERIFICATION_CODE_PATTERN),
  })
  .strict();

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

/**
 * `Secure` em produção ou sempre que a origem do frontend é HTTPS (staging, túnel). O prefixo
 * `__Host-` não foi adotado: exigiria `Secure` também em HTTP local (Safari e proxies de
 * desenvolvimento recusam), então fica como pendência de produção.
 */
export function cookieIsSecure(nodeEnv: string, appOrigin: string): boolean {
  return nodeEnv === 'production' || appOrigin.toLowerCase().startsWith('https:');
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
  const registration = z.object({ email: emailSchema, password: accountPasswordSchema }).strict();
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
    const body = verificationSchema.parse(request.body);
    await service.verify(body.email, body.password, body.code);
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
    // O cookie só é limpo depois da revogação: se o Redis falhar, a resposta é 503 e o cookie
    // continua, para a pessoa tentar sair de novo (nunca finge uma saída que não aconteceu).
    try {
      await service.logout(accountCookie(request.headers.cookie));
    } catch (error) {
      // Cookie ausente ou malformado: não há sessão a revogar; limpar é seguro.
      if (!(error instanceof UnauthorizedError)) throw error;
    }
    return reply.header('set-cookie', cookie('', true)).status(204).send();
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
