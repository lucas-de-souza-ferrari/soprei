import { z } from 'zod';
import {
  contentFromType,
  type InboundChannelEcho,
  type InboundChannelMessage,
} from '../../application/channel/channel-intake.service.js';

/**
 * Formato do webhook da Cloud API (campo `messages`), lido de forma **tolerante**: campos
 * desconhecidos são ignorados e nada que não é usado é lido ou guardado (nome de perfil, por
 * exemplo, nem aparece aqui). Referência: payloads de exemplo na documentação da Meta (ver a spec
 * 011).
 *
 * O que não bate com o formato nunca vira erro 4xx (a Meta retentaria sem chance de sucesso e, com
 * falhas repetidas, pode desativar a assinatura): o controller responde 200 e registra
 * `invalid_payload`.
 */

/** Envelope: só `object` e, em cada `changes[]`, o `field` e o `value` cru. */
export const webhookEnvelopeSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(z.object({ field: z.string().optional(), value: z.unknown().optional() }))
          .optional(),
      }),
    )
    .optional(),
});

/** `value` de uma mudança do campo `messages`: o número do negócio e as listas de eventos. */
export const webhookValueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string().regex(/^[0-9]{1,32}$/) }),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

/**
 * Uma mensagem de entrada. `from` pode estar ausente (a Meta vem trocando o identificador do
 * contato por um id próprio do negócio quando o telefone não está disponível): fica `unknown` aqui
 * e o serviço de entrada decide se é utilizável.
 */
export const webhookMessageSchema = z.object({
  id: z.string().min(1),
  from: z.unknown().optional(),
  type: z.string().optional(),
  text: z.object({ body: z.unknown().optional() }).optional(),
});

/**
 * Campo do eco da coexistência (spec 039, confirmado no E0): mensagem que a equipe enviou pelo
 * aplicativo WhatsApp Business. A lista vem em `value.message_echoes[]` (não em `messages[]`).
 */
export const ECHO_FIELD = 'smb_message_echoes';

/**
 * Campos da coexistência que NÃO são tratados neste corte (spec 039, D6): o histórico importado e a
 * sincronização do estado do aplicativo. São contados e ignorados, sem gravar nada.
 */
export const IGNORED_COEXISTENCE_FIELDS: ReadonlySet<string> = new Set([
  'history',
  'smb_app_state_sync',
]);

/**
 * `value` do campo `smb_message_echoes`: o número do negócio, a lista de ecos e, quando vier, a lista
 * `contacts[]` (só o `wa_id` é lido; o nome de perfil nunca).
 */
export const webhookEchoValueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string().regex(/^[0-9]{1,32}$/) }),
  message_echoes: z.array(z.unknown()).optional(),
  contacts: z.array(z.unknown()).optional(),
});

/** Tipos de eco que viram o texto fixo de mídia e pausam a IA (decisão do dono, revisão da 039). */
export const ECHO_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image',
  'audio',
  'video',
  'document',
  'sticker',
]);

const WA_ID_PATTERN = /^[0-9]{1,32}$/;

/**
 * O `wa_id` do contato quando o `value` traz **exatamente um** contato com `wa_id` válido; senão
 * `undefined` (o chamador usa o `to`). No Brasil o `wa_id` pode vir sem o 9 do celular (12 dígitos)
 * enquanto o `to` de um chat aberto pelo número digitado vem com 13: o `wa_id` é o que a mensagem do
 * contato traz no `from`, então é ele que leva o eco à mesma conversa (revisão da 039, I-1).
 */
function singleContactWaId(contacts: readonly unknown[] | undefined): string | undefined {
  if (contacts?.length !== 1) return undefined;
  const parsed = z.object({ wa_id: z.string().regex(WA_ID_PATTERN) }).safeParse(contacts[0]);
  return parsed.success ? parsed.data.wa_id : undefined;
}

/**
 * Um eco: `to` é o contato (no eco, `from` é o número da empresa). `timestamp`, `from` e os campos
 * identificadores novos de 19 caracteres não são lidos (a ordem vem do instante de recebimento, como na 034).
 */
export const webhookEchoSchema = z.object({
  id: z.string().min(1),
  to: z.unknown().optional(),
  type: z.string().optional(),
  text: z.object({ body: z.unknown().optional() }).optional(),
});

/** Status de entrega de uma mensagem **nossa**: só o status e o primeiro código de erro importam. */
export const webhookStatusSchema = z.object({
  id: z.string().min(1).optional(),
  status: z.string().optional(),
  errors: z.array(z.object({ code: z.unknown().optional() })).optional(),
});

export type WebhookStatusEventName = 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'other';

export interface WebhookStatusEvent {
  readonly status: WebhookStatusEventName;
  /** Id da mensagem nossa a que o status se refere (nunca vai cru a log). */
  readonly messageId: string | undefined;
  /** Primeiro `errors[].code` numérico, quando houver. */
  readonly errorCode: number | undefined;
}

export interface ParsedWebhook {
  readonly messages: InboundChannelMessage[];
  readonly statuses: WebhookStatusEvent[];
  /** Ecos de mensagens enviadas pelo aplicativo (spec 039); só são tratados com a coexistência ligada. */
  readonly echoes: InboundChannelEcho[];
  /** Mudanças de campos da coexistência ignorados de propósito (`history`, `smb_app_state_sync`). */
  readonly ignoredChanges: number;
  /** Algo do corpo não bateu com o formato esperado (e foi ignorado). */
  readonly invalid: boolean;
}

const STATUS_NAMES: ReadonlySet<string> = new Set([
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
]);

/**
 * Extrai do corpo (já com assinatura conferida e JSON válido) as mensagens e os status. Tudo o que
 * não é do campo `messages`, ou não tem o formato esperado, é ignorado (`invalid` marca o segundo
 * caso); o que está certo é aproveitado mesmo que outra parte do corpo esteja errada.
 */
export function parseWebhookBody(body: unknown): ParsedWebhook {
  const envelope = webhookEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    return { messages: [], statuses: [], echoes: [], ignoredChanges: 0, invalid: true };
  }

  const messages: InboundChannelMessage[] = [];
  const statuses: WebhookStatusEvent[] = [];
  const echoes: InboundChannelEcho[] = [];
  let ignoredChanges = 0;
  let invalid = false;

  // Outro objeto que não o do WhatsApp (outro produto da Meta no mesmo app): não é para nós.
  if (envelope.data.object !== undefined && envelope.data.object !== 'whatsapp_business_account') {
    return { messages, statuses, echoes, ignoredChanges, invalid };
  }

  for (const entry of envelope.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === ECHO_FIELD) {
        if (!collectEchoes(change.value, echoes)) invalid = true;
        continue;
      }
      if (change.field !== undefined && IGNORED_COEXISTENCE_FIELDS.has(change.field)) {
        ignoredChanges += 1;
        continue;
      }
      // Outros campos assinados (status de template, qualidade...) não são tratados aqui.
      if (change.field !== undefined && change.field !== 'messages') continue;
      const value = webhookValueSchema.safeParse(change.value);
      if (!value.success) {
        invalid = true;
        continue;
      }
      const phoneNumberId = value.data.metadata.phone_number_id;

      for (const raw of value.data.messages ?? []) {
        const parsed = webhookMessageSchema.safeParse(raw);
        if (!parsed.success) {
          invalid = true;
          continue;
        }
        const message = parsed.data;
        const from = typeof message.from === 'string' ? message.from : undefined;
        const body = message.text?.body;
        messages.push({
          phoneNumberId,
          messageId: message.id,
          sender: from,
          content: contentFromType(message.type, typeof body === 'string' ? body : undefined),
        });
      }

      for (const raw of value.data.statuses ?? []) {
        const parsed = webhookStatusSchema.safeParse(raw);
        if (!parsed.success) {
          invalid = true;
          continue;
        }
        const status = parsed.data.status ?? '';
        const code = parsed.data.errors?.[0]?.code;
        statuses.push({
          status: STATUS_NAMES.has(status) ? (status as WebhookStatusEventName) : 'other',
          messageId: parsed.data.id,
          errorCode: typeof code === 'number' && Number.isInteger(code) ? code : undefined,
        });
      }
    }
  }
  return { messages, statuses, echoes, ignoredChanges, invalid };
}

/** Lê os ecos de um `value` de `smb_message_echoes`; devolve `false` se algo não bateu com o formato. */
function collectEchoes(rawValue: unknown, echoes: InboundChannelEcho[]): boolean {
  const value = webhookEchoValueSchema.safeParse(rawValue);
  if (!value.success) return false;
  let valid = true;
  const phoneNumberId = value.data.metadata.phone_number_id;
  const echoList = value.data.message_echoes ?? [];
  // O `contacts[]` do `value` só identifica o contato sem ambiguidade quando há um único eco.
  const waId = echoList.length === 1 ? singleContactWaId(value.data.contacts) : undefined;
  for (const raw of echoList) {
    const parsed = webhookEchoSchema.safeParse(raw);
    if (!parsed.success) {
      valid = false;
      continue;
    }
    const echo = parsed.data;
    const body = echo.text?.body;
    echoes.push({
      phoneNumberId,
      messageId: echo.id,
      recipient: waId ?? (typeof echo.to === 'string' ? echo.to : undefined),
      content: echoContent(echo.type, body),
    });
  }
  return valid;
}

function echoContent(type: string | undefined, body: unknown): InboundChannelEcho['content'] {
  if (type === 'text') return { kind: 'text', text: typeof body === 'string' ? body : undefined };
  if (type !== undefined && ECHO_MEDIA_TYPES.has(type)) return { kind: 'media' };
  return { kind: 'ignored' };
}
