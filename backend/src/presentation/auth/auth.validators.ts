import { z } from 'zod';
import {
  clientSlugSchema,
  emailSchema,
  loginPasswordSchema,
  newPasswordSchema,
} from '../../application/auth/credentials.js';

/**
 * Corpos de `/auth/*`. Todos `strict` e sem ecoar o valor recebido (as mensagens de erro do Zod
 * trazem só o caminho e o motivo): senha, e-mail e token nunca voltam nem vão ao log por aqui.
 */
export const loginBodySchema = z
  .object({ clientSlug: clientSlugSchema, email: emailSchema, password: loginPasswordSchema })
  .strict();

export const platformLoginBodySchema = z
  .object({ email: emailSchema, password: loginPasswordSchema })
  .strict();

/** O refresh é opaco (`<escopo>.<sessionId>.<segredo>`); o serviço confere o formato. */
export const refreshBodySchema = z.object({ refreshToken: z.string().min(1).max(512) }).strict();

/**
 * `POST /auth/password` (spec 008): a atual vale como no login (sem mínimo, só o teto); a nova
 * segue a política de criação (12 a 128). Nenhum dos dois valores é ecoado.
 */
export const changePasswordBodySchema = z
  .object({ currentPassword: loginPasswordSchema, newPassword: newPasswordSchema })
  .strict();
