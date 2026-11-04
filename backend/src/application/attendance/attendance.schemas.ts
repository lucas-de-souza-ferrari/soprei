import { z } from 'zod';
import {
  CONTACT_REF_MAX_LENGTH,
  EXTERNAL_ID_MAX_LENGTH,
  MESSAGE_CONTENT_MAX_LENGTH,
} from '../../domain/index.js';

/** Sem nenhum caractere de controle (categoria Unicode Cc: quebras de linha, tab, NUL...). */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;
const NO_CONTROL_MESSAGE = 'não pode conter caracteres de controle';

/**
 * Entrada de uma mensagem do contato. O service a valida de novo (como `CompanyService`),
 * porque ele também é chamado por outras camadas no futuro (webhook, fila).
 *
 * - `contactRef`: identificador do contato definido pelo canal, texto livre.
 * - `text`: 1 a 4000 caracteres e não vazio depois de `trim`; guardado como veio.
 * - `externalId`: id da mensagem no canal, para idempotência.
 */
/** Texto de uma mensagem do contato: 1 a 4000 caracteres, não vazio depois de `trim`, sem NUL. */
export const messageTextSchema = z
  .string()
  .max(MESSAGE_CONTENT_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, 'não pode ser vazio')
  // O Postgres recusa NUL em texto (22021): vira 400 aqui, não 500 no banco.
  .refine((value) => !value.includes('\u0000'), 'não pode conter o caractere NUL');

/** Identificador do contato definido pelo canal: texto livre, sem caracteres de controle. */
export const contactRefSchema = z
  .string()
  .regex(NO_CONTROL_CHARS, NO_CONTROL_MESSAGE)
  .trim()
  .min(1)
  .max(CONTACT_REF_MAX_LENGTH);

export const inboundMessageSchema = z
  .object({
    contactRef: contactRefSchema,
    text: messageTextSchema,
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

/** Limites de uma resposta que junta várias mensagens do contato (spec 013). */
export const batchLimitsSchema = z
  .object({
    /** Máximo de mensagens somadas numa resposta. */
    maxMessages: z.number().int().min(1),
    /** Máximo de caracteres somados; uma única mensagem maior que isto segue sozinha. */
    maxChars: z.number().int().min(1),
  })
  .strict();

export type BatchLimits = z.infer<typeof batchLimitsSchema>;
