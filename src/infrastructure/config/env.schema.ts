import { z } from 'zod';

export const ADMIN_API_KEY_MIN_LENGTH = 32;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string({ error: 'variável obrigatória ausente' })
      .regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgresql://'),
    REDIS_URL: z
      .string({ error: 'variável obrigatória ausente' })
      .regex(/^rediss?:\/\//, 'deve ser uma URL redis:// ou rediss://'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1).max(3_600_000).default(30_000),
    DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(5_000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(30_000),
    // Chave temporária das rotas /admin (spec 003); o destino dela é decidido nas specs 007/008.
    // Variável vazia vale como ausente.
    ADMIN_API_KEY: z
      .string()
      .optional()
      .transform((value) => (value === '' ? undefined : value)),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === 'production' &&
      (env.ADMIN_API_KEY === undefined || env.ADMIN_API_KEY.length < ADMIN_API_KEY_MIN_LENGTH)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_API_KEY'],
        message: `obrigatória em produção, com no mínimo ${String(ADMIN_API_KEY_MIN_LENGTH)} caracteres`,
      });
    }
  });

export type Config = z.infer<typeof envSchema>;
