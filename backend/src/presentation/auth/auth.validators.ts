import { z } from 'zod';
import {
  companySlugSchema,
  emailSchema,
  loginPasswordSchema,
  newPasswordSchema,
} from '../../application/auth/credentials.js';

/**
 * Corpos de `/auth/*`. Todos `strict` e sem ecoar o valor recebido (as mensagens de erro do Zod
 * trazem só o caminho e o motivo): senha, e-mail e token nunca voltam nem vão ao log por aqui.
 */
export const loginBodySchema = z
  .object({ companySlug: companySlugSchema, email: emailSchema, password: loginPasswordSchema })
  .strict();

/** Código de 6 dígitos do aplicativo autenticador (spec 044). Formato inválido é 400 e não conta como falha. */
export const totpCodeSchema = z.string().regex(/^[0-9]{6}$/);

/** `code` só é exigido com o segundo fator ligado (spec 044); a regra fica no serviço. */
export const platformLoginBodySchema = z
  .object({ email: emailSchema, password: loginPasswordSchema, code: totpCodeSchema.optional() })
  .strict();

/** Entrada no admin da plataforma pelo cookie (spec 044, E1): o código é sempre obrigatório. */
export const platformSessionLoginBodySchema = z
  .object({ email: emailSchema, password: loginPasswordSchema, code: totpCodeSchema })
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
