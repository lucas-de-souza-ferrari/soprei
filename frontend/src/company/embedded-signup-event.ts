import { z } from 'zod';

/**
 * Evento `message` do popup do Embedded Signup (spec 023). A Meta avisa a janela por `postMessage`;
 * qualquer janela ou iframe também pode mandar um evento, então só vale o que vem de uma origem da
 * lista **estrita** abaixo (comparação por igualdade, nunca `endsWith` nem `includes`: o exemplo
 * oficial da Meta confere só o final do domínio, e `evilfacebook.com` passaria) e que casa com o
 * formato esperado. O servidor ainda refaz a prova de posse com o `code`, então um evento forjado só
 * serve para tentar um envio.
 */
export const FACEBOOK_ORIGINS: readonly string[] = [
  'https://www.facebook.com',
  'https://web.facebook.com',
];

/** Texto acima disto é descartado antes do `JSON.parse`. */
export const MAX_EVENT_TEXT_LENGTH = 8 * 1024;

const ID_PATTERN = /^[0-9]{1,32}$/;

/** Evento de fim do fluxo de coexistência (spec 039, confirmado no E0). */
export const COEXISTENCE_FINISH_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

export type SignupEvent =
  /** `FINISH` simples, com `phone_number_id` e `waba_id` válidos. */
  | { readonly kind: 'finish'; readonly phoneNumberId: string; readonly wabaId: string }
  /**
   * Spec 039: fim do fluxo de coexistência (o número segue no aplicativo WhatsApp Business). O E0
   * confirmou que o evento traz `phone_number_id` e `waba_id` (texto de dígitos); o número é opcional
   * aqui porque o servidor sabe resolvê-lo pela WABA. Só vale numa tentativa de coexistência.
   */
  | {
      readonly kind: 'finish_coexistence';
      readonly phoneNumberId: string | null;
      readonly wabaId: string;
    }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'error' }
  /** `FINISH_ONLY_WABA` e afins: fluxos que o site não suporta. */
  | { readonly kind: 'unsupported' };

const envelopeSchema = z.object({
  type: z.literal('WA_EMBEDDED_SIGNUP'),
  event: z.string().max(64),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Interpreta um evento `message`. Devolve `null` (o evento é ignorado, sem log nem erro na tela) se a
 * origem não é da Meta, o texto é grande demais, o JSON é inválido, o tipo não é
 * `WA_EMBEDDED_SIGNUP` ou os ids de um `FINISH` não são numéricos.
 */
export function parseSignupEvent(origin: string, data: unknown): SignupEvent | null {
  if (!FACEBOOK_ORIGINS.includes(origin)) return null;
  let value: unknown = data;
  if (typeof data === 'string') {
    if (data.length > MAX_EVENT_TEXT_LENGTH) return null;
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return null;
  const { event, data: payload } = envelope.data;
  if (event === 'FINISH') {
    const phoneNumberId = payload?.['phone_number_id'];
    const wabaId = payload?.['waba_id'];
    if (
      typeof phoneNumberId !== 'string' ||
      typeof wabaId !== 'string' ||
      !ID_PATTERN.test(phoneNumberId) ||
      !ID_PATTERN.test(wabaId)
    ) {
      return null;
    }
    return { kind: 'finish', phoneNumberId, wabaId };
  }
  if (event === COEXISTENCE_FINISH_EVENT) {
    const phoneNumberId = payload?.['phone_number_id'];
    const wabaId = payload?.['waba_id'];
    if (typeof wabaId !== 'string' || !ID_PATTERN.test(wabaId)) return null;
    if (phoneNumberId === undefined || phoneNumberId === null) {
      return { kind: 'finish_coexistence', phoneNumberId: null, wabaId };
    }
    if (typeof phoneNumberId !== 'string' || !ID_PATTERN.test(phoneNumberId)) return null;
    return { kind: 'finish_coexistence', phoneNumberId, wabaId };
  }
  if (event === 'CANCEL') return { kind: 'cancel' };
  if (event === 'ERROR') return { kind: 'error' };
  if (event.startsWith('FINISH_')) return { kind: 'unsupported' };
  return null;
}
