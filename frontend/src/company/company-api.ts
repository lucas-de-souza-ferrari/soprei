import { z } from 'zod';
import { ApiError, request } from '../api';
import { openHandoffSchema } from './notifications-api';

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

/** De onde veio a resposta (spec 026): só rótulos; o servidor nunca manda o conteúdo. */
export const sourceSchema = z.object({
  kind: z.enum(['document', 'product', 'schedule']),
  label: z.string().max(200),
});
export type AnswerSource = z.infer<typeof sourceSchema>;

export const attendanceResultSchema = z.object({
  reply: z.object({ text: z.string(), isFallback: z.boolean() }),
  sources: z.array(sourceSchema).max(20).default([]),
});

/** Itens por requisição do painel de conversas (spec 024); o máximo da API continua 200. */
export const CONVERSATIONS_PAGE_SIZE = 30;
export const MESSAGES_PAGE_SIZE = 50;

/**
 * Contratos estritos do painel de conversas (spec 024): campo desconhecido é recusado, e a resposta
 * **não pode** trazer `contactRef` nem `externalId` (o telefone e o wamid nunca chegam ao navegador;
 * se o servidor voltar a mandá-los, a tela falha em vez de exibir).
 */
const isoDate = z.iso.datetime();
const cursorText = z.string().min(1).max(512);

export const conversationSchema = z.strictObject({
  id: z.uuid(),
  contactLabel: z.string().min(1).max(128),
  channel: z.enum(['whatsapp', 'simulator']),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** Spec 030: há pedido de atendimento humano aberto nesta conversa (selo "Humano"). */
  openHandoff: z.boolean().optional(),
});
export type ConversationItem = z.infer<typeof conversationSchema>;

/** A conversa no histórico (spec 030): traz o pedido aberto com o id da notificação, ou `null`. */
export const conversationDetailSchema = conversationSchema.extend({
  openHandoff: openHandoffSchema.nullable().optional(),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const conversationsPageSchema = z.strictObject({
  items: z.array(conversationSchema).max(200),
  nextCursor: cursorText.nullable(),
});
export type ConversationsPage = z.infer<typeof conversationsPageSchema>;

export const messageSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(['USER', 'ASSISTANT']),
  content: z.string().max(100_000),
  isFallback: z.boolean(),
  replyToId: z.uuid().nullable(),
  createdAt: isoDate,
  sentAt: isoDate.nullable(),
});
export type MessageItem = z.infer<typeof messageSchema>;

export const messagesPageSchema = z.strictObject({
  conversation: conversationDetailSchema,
  items: z.array(messageSchema).max(200),
  nextCursor: cursorText.nullable(),
});
export type MessagesPage = z.infer<typeof messagesPageSchema>;

export interface PageParams {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

function queryOf(params: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

const sessionSchema = z.object({ selectedCompanyId: z.uuid().nullable() });

/**
 * Depois de um 404 numa rota da empresa: a empresa selecionada na sessão ainda é `companyId`? Se sim, o
 * 404 é do recurso (canal desabilitado, conversa inexistente); se não, a empresa mudou (outra aba,
 * suspensão). Lança a falha da própria leitura da sessão.
 */
export async function isStillSelected(companyId: string): Promise<boolean> {
  const session = sessionSchema.parse(await request('/auth/session'));
  return session.selectedCompanyId === companyId;
}

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
  conversations: async (companyId: string, params: PageParams = {}) =>
    conversationsPageSchema.parse(
      await request(
        `${companyPath(companyId)}/conversations${queryOf({ limit: params.limit, cursor: params.cursor })}`,
      ),
    ),
  conversationMessages: async (
    companyId: string,
    conversationId: string,
    params: PageParams & { readonly order?: 'asc' | 'desc' } = {},
  ) =>
    messagesPageSchema.parse(
      await request(
        `${companyPath(companyId)}/conversations/${encodeURIComponent(conversationId)}/messages${queryOf({ limit: params.limit, cursor: params.cursor, order: params.order })}`,
      ),
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
