import { z } from 'zod';
import { ApiError, request } from '../api';

/**
 * Contratos e mensagens da área da empresa (spec 023). Toda mensagem mostrada na tela é escolhida aqui
 * pelo `status` e pelo `error.code` da resposta; o texto de erro do servidor ou da Meta nunca é lido
 * nem exibido.
 */
export const PERSONA_MAX_LENGTH = 4000;
export const MESSAGE_MAX_LENGTH = 4000;
/** `contactRef` fixo das conversas de teste feitas pelo site. */
export const TEST_CONTACT_REF = 'teste-no-site';

const idText = z.string().regex(/^[0-9]{1,32}$/);

export const channelStateSchema = z.object({
  state: z.enum(['NOT_CONNECTED', 'CONNECTED', 'TOKEN_INVALID', 'LEGACY']),
  phoneNumberId: z.string().nullable(),
  wabaId: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
  connectedAt: z.string().nullable(),
  tokenInvalidAt: z.string().nullable(),
});
export type ChannelState = z.infer<typeof channelStateSchema>;

export const channelSetupSchema = z.object({
  embeddedSignup: z
    .object({
      appId: idText,
      configId: idText,
      graphApiVersion: z.string().regex(/^v[0-9]{1,3}\.[0-9]{1,3}$/),
    })
    .nullable(),
  manualConnect: z.boolean(),
});
export type ChannelSetup = z.infer<typeof channelSetupSchema>;

export const personaSchema = z.object({ persona: z.string().nullable() });

export const attendanceResultSchema = z.object({
  reply: z.object({ text: z.string(), isFallback: z.boolean() }),
});

const companyPath = (companyId: string): string => `/admin/companies/${companyId}`;

export const companyApi = {
  channel: async (companyId: string) =>
    channelStateSchema.parse(await request(`${companyPath(companyId)}/channel`)),
  setup: async (companyId: string) =>
    channelSetupSchema.parse(await request(`${companyPath(companyId)}/channel/setup`)),
  disconnect: async (companyId: string): Promise<void> => {
    await request(`${companyPath(companyId)}/channel`, { method: 'DELETE' });
  },
  embeddedSignup: async (
    companyId: string,
    body: { code: string; wabaId: string; phoneNumberId: string },
  ) =>
    channelStateSchema.parse(
      await request(`${companyPath(companyId)}/channel/embedded-signup`, {
        method: 'POST',
        body,
      }),
    ),
  manualConnect: async (
    companyId: string,
    body: { phoneNumberId: string; wabaId: string; accessToken: string },
  ) =>
    channelStateSchema.parse(
      await request(`${companyPath(companyId)}/channel`, { method: 'PUT', body }),
    ),
  persona: async (companyId: string) =>
    personaSchema.parse(await request(`${companyPath(companyId)}/persona`)),
  savePersona: async (companyId: string, persona: string | null) =>
    personaSchema.parse(
      await request(`${companyPath(companyId)}/persona`, { method: 'PUT', body: { persona } }),
    ),
  send: async (companyId: string, text: string) =>
    attendanceResultSchema.parse(
      await request(`${companyPath(companyId)}/messages`, {
        method: 'POST',
        body: { contactRef: TEST_CONTACT_REF, text },
      }),
    ),
};

/** O que fazer com uma falha: voltar ao login, avisar que a empresa mudou, ou mostrar uma mensagem. */
export type Failure =
  | { readonly kind: 'session' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'message'; readonly text: string };

export const GENERIC_MESSAGE = 'Não foi possível concluir. Tente novamente.';
export const FORBIDDEN_MESSAGE = 'Você não tem permissão para esta ação.';
export const UNAVAILABLE_MESSAGE =
  'A Meta ou o serviço está indisponível. Tente novamente em instantes.';
export const RATE_MESSAGE = 'Muitas tentativas. Aguarde antes de tentar novamente.';

const CHANNEL_CODE_MESSAGES: Readonly<Record<string, string>> = {
  CHANNEL_TOKEN_REJECTED: 'A Meta recusou a autorização. Tente conectar de novo.',
  CHANNEL_WRONG_APP:
    'A autorização não veio do aplicativo do Soprei. Tente conectar de novo pela janela do site.',
  CHANNEL_MISSING_SCOPE:
    'Faltou conceder todas as permissões do WhatsApp. Conecte de novo e aceite todas.',
  CHANNEL_NUMBER_NOT_IN_WABA:
    'Esse número não pertence à conta escolhida. Selecione o número na janela da Meta.',
  CHANNEL_NUMBER_IN_USE: 'Esse número já está conectado a outra empresa.',
  CHANNEL_CODE_INVALID: 'A autorização expirou ou já foi usada. Tente de novo.',
  CHANNEL_REGISTRATION_FAILED:
    'Não foi possível registrar o número na Meta. Tente de novo; se persistir, fale com o suporte.',
};

/** Traduz uma falha da API em ação de tela. Ignora por completo o texto do corpo de erro. */
export function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiError)) return { kind: 'message', text: GENERIC_MESSAGE };
  const { status, code } = error;
  if (status === 401) return { kind: 'session' };
  if (status === 404) return { kind: 'changed' };
  if (status === 403) return { kind: 'message', text: FORBIDDEN_MESSAGE };
  if (status === 429) return { kind: 'message', text: RATE_MESSAGE };
  if (status === 502 || status === 503) return { kind: 'message', text: UNAVAILABLE_MESSAGE };
  const known = code === undefined ? undefined : CHANNEL_CODE_MESSAGES[code];
  return { kind: 'message', text: known ?? GENERIC_MESSAGE };
}
