import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type {
  ChannelConnectionService,
  ChannelStateView,
} from '../../application/channel/channel-connection.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { ValidationError } from '../../shared/errors/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { subscriptionExempt } from '../common/entitlement-config.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { embeddedSignupBodySchema, putChannelBodySchema } from './channel.validators.js';

/** Valores PÚBLICOS que o site precisa para abrir o Embedded Signup (spec 023): nenhum segredo. */
export interface ChannelSetupInfo {
  readonly appId: string;
  /** Ausente = Embedded Signup indisponível neste ambiente. */
  readonly embeddedSignupConfigId: string | undefined;
  readonly graphApiVersion: string;
  /** `CHANNEL_MANUAL_CONNECT_ENABLED`: só decide se a seção "Avançado" aparece no site. */
  readonly manualConnect: boolean;
  /**
   * Spec 039: coexistência com o aplicativo WhatsApp Business. `configId` é o da coexistência (ou o do
   * Embedded Signup); sem isto (ou desligada) a escolha não aparece e o `mode: coexistence` é recusado.
   */
  readonly coexistence?: { readonly enabled: boolean; readonly configId: string | undefined };
}

export interface AdminChannelControllerOptions {
  /** Sem isto `GET .../channel/setup` não existe. */
  readonly setup?: ChannelSetupInfo | undefined;
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
  /** Spec 039: `API_ONLY`, `COEXISTENCE` ou `null` sem conexão própria. */
  mode: string | null;
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
    mode: view.mode,
  };
}

/**
 * Conexão do canal WhatsApp da própria empresa (spec 015). Registre com `prefix: '/admin/companies'`.
 * O `:companyId` do caminho é conferido contra o do token pelo `requirePermission` (404 antes de 403)
 * e descartado: o service sempre recebe a identidade do token. `PlatformAdmin` recebe 403. Rotas
 * finas; a prova de posse, a cifra e a auditoria moram no service.
 */
export const adminChannelController: FastifyPluginCallback<AdminChannelControllerOptions> = (
  app,
  { auth, metrics, channel, setup },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const coexistenceEnabled = setup?.coexistence?.enabled === true;
  // Spec 039: o `config_id` só é público se a coexistência está ligada (senão a escolha não aparece).
  const coexistenceConfigId = coexistenceEnabled ? (setup.coexistence.configId ?? null) : null;

  app.get(
    '/:companyId/channel',
    {
      config,
      onRequest: requirePermission('channel:read', { companyParam: 'companyId', metrics }),
    },
    async (request) => toResponse(await channel.getState(membershipAuth(request))),
  );

  // Spec 023: só quem pode conectar (channel:manage) recebe o app id e o config_id (públicos).
  if (setup !== undefined) {
    app.get(
      '/:companyId/channel/setup',
      {
        config,
        onRequest: requirePermission('channel:manage', { companyParam: 'companyId', metrics }),
      },
      () => ({
        embeddedSignup:
          setup.embeddedSignupConfigId === undefined
            ? null
            : {
                appId: setup.appId,
                configId: setup.embeddedSignupConfigId,
                graphApiVersion: setup.graphApiVersion,
              },
        manualConnect: setup.manualConnect,
        // Spec 039: só valores públicos.
        coexistence: { available: coexistenceConfigId !== null, configId: coexistenceConfigId },
      }),
    );
  }

  app.put(
    '/:companyId/channel',
    {
      config,
      onRequest: requirePermission('channel:manage', { companyParam: 'companyId', metrics }),
    },
    async (request) => {
      const body = putChannelBodySchema.parse(request.body);
      return toResponse(await channel.connect(membershipAuth(request), body));
    },
  );

  // Embedded Signup (spec 015b): o `code` do navegador vira o token no servidor; mesma prova de posse
  // do PUT. Nunca loga nem devolve o `code`; resposta igual à do GET.
  app.post(
    '/:companyId/channel/embedded-signup',
    {
      config,
      onRequest: requirePermission('channel:manage', { companyParam: 'companyId', metrics }),
    },
    async (request) => {
      const body = embeddedSignupBodySchema.parse(request.body);
      // Spec 039: sem a coexistência ligada, o modo novo não existe (400, mensagem fixa).
      if (body.mode === 'coexistence' && !coexistenceEnabled) {
        throw new ValidationError('Dados inválidos', { code: 'CHANNEL_COEXISTENCE_DISABLED' });
      }
      return toResponse(await channel.embeddedSignup(membershipAuth(request), body));
    },
  );

  // Desconectar o canal segue funcionando com a assinatura inativa (spec 031, D6).
  app.delete(
    '/:companyId/channel',
    {
      config: { ...config, ...subscriptionExempt() },
      onRequest: requirePermission('channel:manage', { companyParam: 'companyId', metrics }),
    },
    async (request, reply) => {
      await channel.disconnect(membershipAuth(request));
      return reply.status(204).send();
    },
  );

  done();
};
