import type { CompanyId } from '../value-objects/company-id.js';

export const COMPANY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** Limite de caracteres da persona do assistente. */
export const PERSONA_MAX_LENGTH = 4000;

/** `phone_number_id` do WhatsApp (Meta): 1 a 32 dígitos. */
export const WHATSAPP_PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,32}$/;

/** Minúsculas, dígitos e hífen; 3 a 63 caracteres. */
export const COMPANY_SLUG_PATTERN = /^[a-z0-9-]{3,63}$/;

/** Empresa (tenant). É a raiz do isolamento: não pertence a outra empresa. */
export interface Company {
  readonly id: CompanyId;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  /** Persona do assistente; nula = persona padrão. Nunca vai para log. */
  readonly persona: string | null;
  /** `phone_number_id` do número do WhatsApp desta empresa; nulo = canal não ligado a um número. */
  readonly whatsappPhoneNumberId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewCompany {
  readonly name: string;
  readonly slug: string;
  readonly status?: CompanyStatus;
}

export interface CompanyUpdate {
  readonly name?: string;
  readonly status?: CompanyStatus;
  /** `null` limpa a persona (volta à padrão). */
  readonly persona?: string | null;
  /** `null` desliga o número. Único entre empresas (`ConflictError` se já está em uso). */
  readonly whatsappPhoneNumberId?: string | null;
}
