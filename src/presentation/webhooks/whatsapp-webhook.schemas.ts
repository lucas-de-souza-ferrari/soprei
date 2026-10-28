import { z } from 'zod';
import type { InboundChannelMessage } from '../../application/channel/channel-intake.service.js';

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
  if (!envelope.success) return { messages: [], statuses: [], invalid: true };

  const messages: InboundChannelMessage[] = [];
  const statuses: WebhookStatusEvent[] = [];
  let invalid = false;

  // Outro objeto que não o do WhatsApp (outro produto da Meta no mesmo app): não é para nós.
  if (envelope.data.object !== undefined && envelope.data.object !== 'whatsapp_business_account') {
    return { messages, statuses, invalid };
  }

  for (const entry of envelope.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
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
          content:
            message.type === 'text'
              ? { kind: 'text', text: typeof body === 'string' ? body : undefined }
              : { kind: 'unsupported' },
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
  return { messages, statuses, invalid };
}
