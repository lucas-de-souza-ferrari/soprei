import { z } from 'zod';
import { emailSchema, newPasswordSchema } from '../../application/auth/credentials.js';
import { USER_ROLES, USER_STATUSES } from '../../domain/index.js';

/**
 * Corpos de `/admin/clients/:clientId/users`. Todos `strict`; as mensagens de erro do Zod trazem só
 * o caminho e o motivo, nunca o valor recebido (e-mail e senha não voltam nem vão ao log).
 */
export const createUserBodySchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    role: z.enum(USER_ROLES),
  })
  .strict();

/** Ao menos um campo: um `PATCH` vazio é 400. */
export const updateUserBodySchema = z
  .object({
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: 'informe role, status ou os dois',
  });

export const resetPasswordBodySchema = z.object({ newPassword: newPasswordSchema }).strict();
