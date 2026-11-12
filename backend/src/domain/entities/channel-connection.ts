import type { WithoutCompanyId } from '../repositories/tenant.repository.js';
import type { CompanyId } from '../value-objects/company-id.js';

export const CHANNEL_CONNECTION_STATUSES = ['CONNECTED', 'TOKEN_INVALID'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

/** Como o número foi conectado (spec 039): só pela Cloud API ou junto com o aplicativo no celular. */
export const CHANNEL_CONNECTION_MODES = ['API_ONLY', 'COEXISTENCE'] as const;
export type ChannelConnectionMode = (typeof CHANNEL_CONNECTION_MODES)[number];

/** `waba_id` da Meta: 1 a 32 dígitos. */
export const WABA_ID_PATTERN = /^[0-9]{1,32}$/;

/**
 * Credencial do canal de uma empresa (spec 015, model de tenant, uma por empresa). O token só existe
 * **cifrado** (`tokenCiphertext`, amarrado ao `companyId` pela AAD); nunca vai a log, resposta nem
 * métrica. O número continua em `Company.whatsappPhoneNumberId`.
 */
export interface ChannelConnection {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly wabaId: string;
  readonly tokenCiphertext: string;
  /** PIN do registro do número (spec 015b), cifrado como o token; `null` na conexão manual. */
  readonly registrationPinCiphertext: string | null;
  /** +1 a cada token gravado; a marca `TOKEN_INVALID` é condicional a ele. */
  readonly tokenVersion: number;
  readonly status: ChannelConnectionStatus;
  /** Spec 039: `COEXISTENCE` quando o número segue no aplicativo WhatsApp Business. */
  readonly mode: ChannelConnectionMode;
  readonly tokenExpiresAt: Date | null;
  readonly tokenInvalidAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewChannelConnection extends WithoutCompanyId {
  readonly wabaId: string;
  readonly tokenCiphertext: string;
  readonly tokenExpiresAt: Date | null;
  /** Sempre explícito na gravação (spec 039): um `PUT` ou Embedded Signup posterior troca o modo. */
  readonly mode: ChannelConnectionMode;
  /** Se informado, grava (ou troca) o PIN cifrado; ausente mantém o que já existe. */
  readonly registrationPinCiphertext?: string | null;
}

export interface ChannelConnectionUpdate extends WithoutCompanyId {
  readonly wabaId?: string;
  readonly tokenCiphertext?: string;
  readonly tokenExpiresAt?: Date | null;
}
