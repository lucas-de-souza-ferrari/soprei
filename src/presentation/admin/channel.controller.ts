import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type {
  ChannelConnectionService,
  ChannelStateView,
} from '../../application/channel/channel-connection.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, userAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { embeddedSignupBodySchema, putChannelBodySchema } from './channel.validators.js';

export interface AdminChannelControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly channel: Pick<
    ChannelConnectionService,
    'getState' | 'connect' | 'disconnect' | 'embeddedSignup'
  >;
}

interface ChannelResponse {
  state: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  tokenInvalidAt: string | null;
}

/** Só estado e identificadores de negócio: nunca o token, o texto cifrado nem a chave. */
function toResponse(view: ChannelStateView): ChannelResponse {
  return {
    state: view.state,
    phoneNumberId: view.phoneNumberId,
    wabaId: view.wabaId,
    tokenExpiresAt: view.tokenExpiresAt?.toISOString() ?? null,
    connectedAt: view.connectedAt?.toISOString() ?? null,
    tokenInvalidAt: view.tokenInvalidAt?.toISOString() ?? null,
  };
}

/**
 * Conexão do canal WhatsApp do próprio cliente (spec 015). Registre com `prefix: '/admin/clients'`.
 * O `:clientId` do caminho é conferido contra o do token pelo `requirePermission` (404 antes de 403)
 * e descartado: o service sempre recebe a identidade do token. `PlatformAdmin` recebe 403. Rotas
 * finas; a prova de posse, a cifra e a auditoria moram no service.
 */
export const adminChannelController: FastifyPluginCallback<AdminChannelControllerOptions> = (
  app,
  { auth, metrics, channel },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');

  app.get(
    '/:clientId/channel',
    {
      config,
      onRequest: requirePermission('channel:read', { clientParam: 'clientId', metrics }),
    },
    async (request) => toResponse(await channel.getState(userAuth(request))),
  );

  app.put(
    '/:clientId/channel',
    {
      config,
      onRequest: requirePermission('channel:manage', { clientParam: 'clientId', metrics }),
    },
    async (request) => {
      const body = putChannelBodySchema.parse(request.body);
      return toResponse(await channel.connect(userAuth(request), body));
    },
  );

  // Embedded Signup (spec 015b): o `code` do navegador vira o token no servidor; mesma prova de posse
  // do PUT. Nunca loga nem devolve o `code`; resposta igual à do GET.
  app.post(
    '/:clientId/channel/embedded-signup',
    {
      config,
      onRequest: requirePermission('channel:manage', { clientParam: 'clientId', metrics }),
    },
    async (request) => {
      const body = embeddedSignupBodySchema.parse(request.body);
      return toResponse(await channel.embeddedSignup(userAuth(request), body));
    },
  );

  app.delete(
    '/:clientId/channel',
    {
      config,
      onRequest: requirePermission('channel:manage', { clientParam: 'clientId', metrics }),
    },
    async (request, reply) => {
      await channel.disconnect(userAuth(request));
      return reply.status(204).send();
    },
  );

  done();
};
