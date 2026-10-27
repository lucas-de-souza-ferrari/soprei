import { z } from 'zod';
import {
  CONTACT_REF_MAX_LENGTH,
  EXTERNAL_ID_MAX_LENGTH,
  MESSAGE_CONTENT_MAX_LENGTH,
} from '../domain/index.js';

/** Sem nenhum caractere de controle (categoria Unicode Cc: quebras de linha, tab, NUL...). */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;
const NO_CONTROL_MESSAGE = 'não pode conter caracteres de controle';

/**
 * Entrada de uma mensagem do contato. O service a valida de novo (como `ClientService`),
 * porque ele também é chamado por outras camadas no futuro (webhook, fila).
 *
 * - `contactRef`: identificador do contato definido pelo canal, texto livre.
 * - `text`: 1 a 4000 caracteres e não vazio depois de `trim`; guardado como veio.
 * - `externalId`: id da mensagem no canal, para idempotência.
 */
export const inboundMessageSchema = z
  .object({
    contactRef: z
      .string()
      .regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE)
      .trim()
      .min(1)
      .max(CONTACT_REF_MAX_LENGTH),
    text: z
      .string()
      .max(MESSAGE_CONTENT_MAX_LENGTH)
      .refine((value) => value.trim().length > 0, 'não pode ser vazio')
      // O Postgres recusa NUL em texto (22021): vira 400 aqui, não 500 no banco.
      .refine((value) => !value.includes('\u0000'), 'não pode conter o caractere NUL'),
    externalId: z
      .string()
      .regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE)
      .trim()
      .min(1)
      .max(EXTERNAL_ID_MAX_LENGTH)
      .optional(),
  })
  .strict();

export type InboundMessage = z.infer<typeof inboundMessageSchema>;
