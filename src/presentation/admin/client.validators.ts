import { z } from 'zod';
import {
  CLIENT_SLUG_PATTERN,
  CLIENT_STATUSES,
  ClientId,
  MAX_LIST_LIMIT,
  PERSONA_MAX_LENGTH,
  WHATSAPP_PHONE_NUMBER_ID_PATTERN,
} from '../../domain/index.js';
import { CLIENT_NAME_MAX_LENGTH } from '../../application/clients/client.service.js';
import { ValidationError } from '../../shared/errors/index.js';

const nameSchema = z.string().trim().min(1).max(CLIENT_NAME_MAX_LENGTH);
const statusSchema = z.enum(CLIENT_STATUSES);

/** `:id` da rota vira `ClientId`; id inválido é 400 (ZodError no handler central). */
export const clientIdSchema = z.string().transform((value, ctx) => {
  try {
    return ClientId.parse(value);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: 'custom', message: 'deve ser um UUID válido' });
    return z.NEVER;
  }
});

export const clientParamsSchema = z.object({ id: clientIdSchema });

export const createClientBodySchema = z
  .object({
    name: nameSchema,
    slug: z
      .string()
      .regex(CLIENT_SLUG_PATTERN, 'de 3 a 63 caracteres: minúsculas, dígitos e hífen'),
    status: statusSchema.optional(),
  })
  .strict();

export const updateClientBodySchema = z
  .object({
    name: nameSchema.optional(),
    status: statusSchema.optional(),
    // `null` limpa a persona (volta à padrão). Nunca é logada.
    persona: z
      .string()
      .trim()
      .min(1)
      .max(PERSONA_MAX_LENGTH)
      // O Postgres recusa NUL em texto (22021): vira 400 aqui, não 500 no banco.
      .refine((value) => !value.includes('\u0000'), 'não pode conter o caractere NUL')
      .nullable()
      .optional(),
    // `phone_number_id` da Meta (1 a 32 dígitos); `null` desliga o número. Único entre clientes.
    whatsappPhoneNumberId: z
      .string()
      .regex(WHATSAPP_PHONE_NUMBER_ID_PATTERN, 'de 1 a 32 dígitos')
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.status !== undefined ||
      body.persona !== undefined ||
      body.whatsappPhoneNumberId !== undefined,
    { message: 'informe name, status, persona ou whatsappPhoneNumberId' },
  );

export const listClientsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
