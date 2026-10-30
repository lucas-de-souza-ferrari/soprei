import type { WithoutClientId } from '../repositories/tenant.repository.js';
import type { ClientId } from '../value-objects/client-id.js';

export const CHANNEL_CONNECTION_STATUSES = ['CONNECTED', 'TOKEN_INVALID'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

/** `waba_id` da Meta: 1 a 32 dígitos. */
export const WABA_ID_PATTERN = /^[0-9]{1,32}$/;

/**
 * Credencial do canal de um cliente (spec 015, model de tenant, uma por cliente). O token só existe
 * **cifrado** (`tokenCiphertext`, amarrado ao `clientId` pela AAD); nunca vai a log, resposta nem
 * métrica. O número continua em `Client.whatsappPhoneNumberId`.
 */
export interface ChannelConnection {
  readonly id: string;
  readonly clientId: ClientId;
  readonly wabaId: string;
  readonly tokenCiphertext: string;
  /** PIN do registro do número (spec 015b), cifrado como o token; `null` na conexão manual. */
  readonly registrationPinCiphertext: string | null;
  /** +1 a cada token gravado; a marca `TOKEN_INVALID` é condicional a ele. */
  readonly tokenVersion: number;
  readonly status: ChannelConnectionStatus;
  readonly tokenExpiresAt: Date | null;
  readonly tokenInvalidAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewChannelConnection extends WithoutClientId {
  readonly wabaId: string;
  readonly tokenCiphertext: string;
  readonly tokenExpiresAt: Date | null;
  /** Se informado, grava (ou troca) o PIN cifrado; ausente mantém o que já existe. */
  readonly registrationPinCiphertext?: string | null;
}

export interface ChannelConnectionUpdate extends WithoutClientId {
  readonly wabaId?: string;
  readonly tokenCiphertext?: string;
  readonly tokenExpiresAt?: Date | null;
}
