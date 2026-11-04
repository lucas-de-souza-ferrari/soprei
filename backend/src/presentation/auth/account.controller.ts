import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../../application/auth/account.service.js';
import type { InvitationService } from '../../application/invitations/invitation.service.js';
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

/** Corpo de `POST /auth/password-reset/request` (spec 021): só o e-mail. */
export const passwordResetRequestSchema = z.object({ email: emailSchema }).strict();

/**
 * Corpo de `POST /auth/password-reset/confirm` (spec 021): o código são exatamente 6 dígitos e a
 * senha nova segue a política do cadastro público (o mesmo schema, para não divergir). Formato
 * inválido é 400 antes de qualquer consulta e nunca conta como tentativa.
 */
export const passwordResetConfirmSchema = z
  .object({
    email: emailSchema,
    code: z.string().regex(VERIFICATION_CODE_PATTERN),
    newPassword: accountPasswordSchema,
  })
  .strict();

/**
 * Corpos das rotas públicas de convite (spec 025). O token é só limitado em tamanho aqui: formato
 * malformado, vencido, usado e o resto são a MESMA falha uniforme do service (400 `INVITATION_INVALID`),
 * não um 400 de validação que distinguiria o problema. Estritos; a senha segue a política do cadastro.
 */
const invitationToken = z.string().max(4096);
export const invitationTokenSchema = z.object({ token: invitationToken }).strict();
export const invitationAcceptNewSchema = z
  .object({ token: invitationToken, password: accountPasswordSchema })
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
  /** Convites (spec 025); sem isto as rotas `/auth/invitations/*` não existem (404). */
  invitations?: Pick<InvitationService, 'preview' | 'accept' | 'acceptNew'>;
  origin: string;
  secure: boolean;
}> = (app, { service, origin, secure, legacyAuth, invitations }, done) => {
  const cookie = (value: string, clear = false): string =>
    `${ACCOUNT_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 30 * 86400}${secure ? '; Secure' : ''}`;
  const credentials = z.object({ email: emailSchema, password: loginPasswordSchema }).strict();
  const registration = z.object({ email: emailSchema, password: accountPasswordSchema }).strict();
  app.addHook('onRequest', (request, reply, next) => {
    void reply.header('cache-control', 'no-store');
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.routeOptions.url !== '/auth/logout' &&
      (request.headers.origin !== origin || request.headers['x-soprei-app'] !== 'web')
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
  app.post('/auth/password-reset/request', login, async (request, reply) => {
    const body = passwordResetRequestSchema.parse(request.body);
    await service.requestPasswordReset(body.email);
    // Sempre a mesma resposta: o site nunca revela se existe conta para o e-mail.
    return reply.status(202).send({
      message: 'Se existir uma conta, enviamos um código para o e-mail informado.',
    });
  });
  app.post('/auth/password-reset/confirm', login, async (request, reply) => {
    const body = passwordResetConfirmSchema.parse(request.body);
    await service.confirmPasswordReset(body.email, body.code, body.newPassword);
    // Sem cookie e sem login automático: a pessoa entra com a senha nova.
    return reply.status(204).send();
  });
  if (invitations !== undefined) {
    // Rotas públicas de convite (spec 025): perfil `login` (fail-closed), sem login automático.
    app.post('/auth/invitations/preview', login, async (request) => {
      const body = invitationTokenSchema.parse(request.body);
      return invitations.preview(body.token);
    });
    app.post('/auth/invitations/accept', login, async (request, reply) => {
      // Sem cookie válido = 401 (o site vai ao login e volta ao convite).
      const secret = accountCookie(request.headers.cookie);
      const body = invitationTokenSchema.parse(request.body);
      const account = await service.me(secret);
      const { companyId } = await invitations.accept(account, body.token);
      // A empresa nova passa a ser a selecionada na sessão (Redis fora aqui = 503 com o vínculo criado).
      await service.selectCompany(secret, companyId);
      return reply.status(204).send();
    });
    app.post('/auth/invitations/accept-new', login, async (request, reply) => {
      const body = invitationAcceptNewSchema.parse(request.body);
      await invitations.acceptNew(body.token, body.password);
      // Sem cookie e sem login automático: a pessoa entra com a senha que definiu.
      return reply.status(204).send();
    });
  }
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
    if (request.headers.origin !== origin || request.headers['x-soprei-app'] !== 'web')
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
  app.post('/account/companies/:companyId/select', admin, async (request, reply) => {
    const { companyId } = z.object({ companyId: z.uuid() }).parse(request.params);
    await service.selectCompany(accountCookie(request.headers.cookie), companyId);
    return reply.status(204).send();
  });
  done();
};
