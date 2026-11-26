import { z } from 'zod';
import {
  COMPANY_SLUG_PATTERN,
  EMAIL_MAX_LENGTH,
  isAnonymizedEmailDomain,
} from '../../domain/index.js';

/** Política de senha (NIST SP 800-63B): só tamanho, sem regras de composição. */
export const PASSWORD_MIN_LENGTH = 12;
/** O teto limita o custo de hash por requisição. */
export const PASSWORD_MAX_LENGTH = 128;
/** Teto do valor cru, antes da normalização NFKC (que pode expandir): limita o trabalho dela. */
const PASSWORD_RAW_MAX_LENGTH = 1024;

/** E-mail: NFKC, `trim`, minúsculas, formato válido e até 254 caracteres. O valor nunca é ecoado. */
export const emailSchema = z
  .string()
  .max(1024)
  .transform((value) => value.normalize('NFKC').trim().toLowerCase())
  .pipe(z.email().max(EMAIL_MAX_LENGTH))
  // O domínio das contas removidas (spec 045, E6) é reservado: ninguém se cadastra nem entra com ele.
  .refine((value) => !isAnonymizedEmailDomain(value), 'domínio reservado');

function passwordBase(): z.ZodType<string> {
  return z
    .string()
    .max(PASSWORD_RAW_MAX_LENGTH)
    .refine((value) => !value.includes('\u0000'), 'não pode conter o caractere NUL')
    .transform((value) => value.normalize('NFKC'));
}

/** Senha nova: 12 a 128 caracteres depois do NFKC, sem NUL. */
export const newPasswordSchema = passwordBase().pipe(
  z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
);

/** Cadastro público: mínimo de seis caracteres, uma maiúscula Unicode e um dígito. */
export const accountPasswordSchema = passwordBase().pipe(
  z
    .string()
    .min(6)
    .max(PASSWORD_MAX_LENGTH)
    .regex(/\p{Lu}/u)
    .regex(/[0-9]/),
);

/**
 * Senha apresentada no login: mesma normalização e teto, mas sem o mínimo (o mínimo é regra de
 * criação; um 400 aqui separaria "senha curta" de "senha errada" sem ganho algum).
 */
export const loginPasswordSchema = passwordBase().pipe(z.string().min(1).max(PASSWORD_MAX_LENGTH));

export const companySlugSchema = z
  .string()
  .regex(COMPANY_SLUG_PATTERN, 'de 3 a 63 caracteres: minúsculas, dígitos e hífen');

/** Normaliza um e-mail já validado (para quem não passa pelo Zod). */
export function normalizeEmail(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
