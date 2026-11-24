import { z } from 'zod';
import {
  COMPANY_SLUG_PATTERN,
  COMPANY_STATUSES,
  CompanyId,
  MAX_LIST_LIMIT,
  PERSONA_MAX_LENGTH,
} from '../../domain/index.js';
import { COMPANY_NAME_MAX_LENGTH } from '../../application/companies/company.service.js';
import { ValidationError } from '../../shared/errors/index.js';

const nameSchema = z.string().trim().min(1).max(COMPANY_NAME_MAX_LENGTH);
const statusSchema = z.enum(COMPANY_STATUSES);

/** `:id` da rota vira `CompanyId`; id inválido é 400 (ZodError no handler central). */
export const companyIdSchema = z.string().transform((value, ctx) => {
  try {
    return CompanyId.parse(value);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: 'custom', message: 'deve ser um UUID válido' });
    return z.NEVER;
  }
});

export const companyParamsSchema = z.object({ id: companyIdSchema });

export const createCompanyBodySchema = z
  .object({
    name: nameSchema,
    slug: z
      .string()
      .regex(COMPANY_SLUG_PATTERN, 'de 3 a 63 caracteres: minúsculas, dígitos e hífen'),
    status: statusSchema.optional(),
  })
  .strict();

// `null` limpa a persona (volta à padrão). Nunca é logada.
const personaSchema = z
  .string()
  .trim()
  .min(1)
  .max(PERSONA_MAX_LENGTH)
  // O Postgres recusa NUL em texto (22021): vira 400 aqui, não 500 no banco.
  .refine((value) => !value.includes('\u0000'), 'não pode conter o caractere NUL')
  .nullable();

/** Corpo de `PUT /admin/companies/:companyId/persona` (spec 023): só `persona`, nada mais. */
export const putPersonaBodySchema = z.object({ persona: personaSchema }).strict();

/**
 * Corpo do `PATCH /admin/companies/:id` (plataforma). Sem `persona` desde a spec 044 (D8): a plataforma não
 * lê nem altera conteúdo da empresa; o campo é recusado (400, `strict`).
 */
export const updateCompanyBodySchema = z
  .object({
    name: nameSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.status !== undefined, {
    message: 'informe name ou status',
  });

export const listCompaniesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
