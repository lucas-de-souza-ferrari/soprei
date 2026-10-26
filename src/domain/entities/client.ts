import type { ClientId } from '../value-objects/client-id.js';

export const CLIENT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Minúsculas, dígitos e hífen; 3 a 63 caracteres. */
export const CLIENT_SLUG_PATTERN = /^[a-z0-9-]{3,63}$/;

/** Cliente (tenant). É a raiz do isolamento: não pertence a outro cliente. */
export interface Client {
  readonly id: ClientId;
  readonly name: string;
  readonly slug: string;
  readonly status: ClientStatus;
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
}
