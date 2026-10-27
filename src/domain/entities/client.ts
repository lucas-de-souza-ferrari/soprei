import type { ClientId } from '../value-objects/client-id.js';

export const CLIENT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Limite de caracteres da persona do assistente. */
export const PERSONA_MAX_LENGTH = 4000;

/** `phone_number_id` do WhatsApp (Meta): 1 a 32 dígitos. */
export const WHATSAPP_PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,32}$/;

/** Minúsculas, dígitos e hífen; 3 a 63 caracteres. */
export const CLIENT_SLUG_PATTERN = /^[a-z0-9-]{3,63}$/;

/** Cliente (tenant). É a raiz do isolamento: não pertence a outro cliente. */
export interface Client {
  readonly id: ClientId;
  readonly name: string;
  readonly slug: string;
  readonly status: ClientStatus;
  /** Persona do assistente; nula = persona padrão. Nunca vai para log. */
  readonly persona: string | null;
  /** `phone_number_id` do número do WhatsApp deste cliente; nulo = canal não ligado a um número. */
  readonly whatsappPhoneNumberId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewClient {
  readonly name: string;
  readonly slug: string;
  readonly status?: ClientStatus;
}

export interface ClientUpdate {
  readonly name?: string;
  readonly status?: ClientStatus;
  /** `null` limpa a persona (volta à padrão). */
  readonly persona?: string | null;
  /** `null` desliga o número. Único entre clientes (`ConflictError` se já está em uso). */
  readonly whatsappPhoneNumberId?: string | null;
}
