import { z } from 'zod';
import { parseTrustProxy, type TrustProxySetting } from './trust-proxy.js';

export const ADMIN_API_KEY_MIN_LENGTH = 32;
export const METRICS_TOKEN_MIN_LENGTH = 32;

/** Provedores de LLM disponíveis. O real entra em spec própria; por ora só o `mock`. */
export const LLM_PROVIDERS = ['mock'] as const;

/** `true`/`false` literais; vazio vale como ausente. `z.coerce.boolean` trataria "false" como verdadeiro. */
const booleanLiteral = (defaultValue: boolean): z.ZodType<boolean> =>
  z
    .enum(['true', 'false'], { error: 'deve ser "true" ou "false"' })
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value === 'true'));

const emptyAsUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const rateLimitMax = (defaultValue: number): z.ZodType<number> =>
  z.coerce.number().int().min(1).max(1_000_000).default(defaultValue);
const rateLimitWindowSeconds = (defaultValue: number): z.ZodType<number> =>
  z.coerce.number().int().min(1).max(86_400).default(defaultValue);

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
    // Token de GET /metrics (spec 004). Sem ele a rota não existe (404); vazia vale como ausente.
    METRICS_TOKEN: z
      .string()
      .optional()
      .transform((value) => (value === '' ? undefined : value)),
    // Atendimento (spec 010). Provedor de LLM e prazo máximo de uma chamada ao modelo.
    LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('mock'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(15_000),
    // Mensagem do contato sem resposta há mais que isto deixa de ser "em andamento": a
    // retentativa com o mesmo externalId completa o fluxo em vez de receber 409.
    ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: z.coerce.number().int().min(1).max(3_600_000).default(60_000),
    // Rate limiting (spec 005). Limites por perfil e por IP, guardados no Redis.
    // `false` literal desliga fora de produção; em produção é rejeitado (ver superRefine).
    RATE_LIMIT_ENABLED: z.preprocess(emptyAsUndefined, booleanLiteral(true)),
    RATE_LIMIT_PUBLIC_MAX: rateLimitMax(100),
    RATE_LIMIT_PUBLIC_WINDOW_SECONDS: rateLimitWindowSeconds(900),
    RATE_LIMIT_ADMIN_MAX: rateLimitMax(600),
    RATE_LIMIT_ADMIN_WINDOW_SECONDS: rateLimitWindowSeconds(60),
    RATE_LIMIT_WEBHOOK_MAX: rateLimitMax(600),
    RATE_LIMIT_WEBHOOK_WINDOW_SECONDS: rateLimitWindowSeconds(60),
    // Prazo de cada comando da conexão Redis dedicada ao limiter; estourou: fail-open.
    RATE_LIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(10_000).default(250),
    // IP atrás de proxy: false | true | lista de IPs/CIDRs dos proxies (ver trust-proxy.ts).
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((value, ctx): TrustProxySetting => {
        const parsed = parseTrustProxy(value);
        if (parsed.ok) return parsed.value;
        ctx.addIssue({ code: 'custom', message: parsed.message });
        return z.NEVER;
      }),
  })
  .superRefine((env, ctx) => {
    // `true` confia em toda a cadeia de X-Forwarded-For: o cliente escolhe o IP e escapa do limite.
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'não pode ser "true" em produção (o cliente escolheria o próprio IP); liste os IPs/CIDRs dos proxies, ex.: 127.0.0.1,::1',
      });
    }
    if (env.NODE_ENV === 'production' && !env.RATE_LIMIT_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_ENABLED'],
        message: 'não pode ser "false" em produção (a proteção contra abuso ficaria desligada)',
      });
    }
    if (env.METRICS_TOKEN !== undefined && env.METRICS_TOKEN.length < METRICS_TOKEN_MIN_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_TOKEN'],
        message: `se informado, precisa ter no mínimo ${String(METRICS_TOKEN_MIN_LENGTH)} caracteres`,
      });
    }
    // Senão uma chamada ao LLM ainda dentro do prazo já seria tratada como "abandonada" e a
    // retentativa a retomaria, gerando uma segunda chamada ao modelo para a mesma mensagem.
    if (env.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS <= env.LLM_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['ATTENDANCE_IN_FLIGHT_TIMEOUT_MS'],
        message: `precisa ser maior que LLM_TIMEOUT_MS (${String(env.LLM_TIMEOUT_MS)} ms), senão uma chamada ainda dentro do prazo seria retomada como abandonada`,
      });
    }
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
