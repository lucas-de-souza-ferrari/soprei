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

/** Segredo opcional: vazio vale como ausente. */
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

/** Versão do Graph API no formato `vNN.N` (ex.: `v26.0`). */
const GRAPH_API_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export const WHATSAPP_VERIFY_TOKEN_MIN_LENGTH = 16;
/** Versão estável do Graph API vigente quando a spec 011 foi implementada (ver a spec). */
export const DEFAULT_WHATSAPP_GRAPH_API_VERSION = 'v26.0';

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
    // Canal WhatsApp (spec 011). Opt-in: sem `WHATSAPP_ENABLED=true` as rotas do webhook não existem.
    WHATSAPP_ENABLED: z.preprocess(emptyAsUndefined, booleanLiteral(false)),
    WHATSAPP_APP_SECRET: optionalSecret,
    WHATSAPP_VERIFY_TOKEN: optionalSecret,
    WHATSAPP_ACCESS_TOKEN: optionalSecret,
    WHATSAPP_API_BASE_URL: z.preprocess(
      emptyAsUndefined,
      z.string().url().default('https://graph.facebook.com'),
    ),
    WHATSAPP_GRAPH_API_VERSION: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(GRAPH_API_VERSION_PATTERN, 'deve ter o formato vNN.N, ex.: v26.0')
        .default(DEFAULT_WHATSAPP_GRAPH_API_VERSION),
    ),
    WHATSAPP_SEND_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
    // Fila de entrada do canal (BullMQ). Backoff exponencial: QUEUE_BACKOFF_MS, 2x, 4x...
    QUEUE_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    QUEUE_BACKOFF_MS: z.coerce.number().int().min(1).max(3_600_000).default(10_000),
    QUEUE_KEEP_COMPLETED_SECONDS: z.coerce.number().int().min(1).max(2_592_000).default(3_600),
    QUEUE_KEEP_FAILED_SECONDS: z.coerce.number().int().min(1).max(2_592_000).default(86_400),
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
    refineWhatsapp(env, ctx);
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

/** Regras do canal WhatsApp (spec 011): só valem com `WHATSAPP_ENABLED=true`, salvo a URL base. */
function refineWhatsapp(
  env: {
    readonly NODE_ENV: 'development' | 'test' | 'production';
    readonly WHATSAPP_ENABLED: boolean;
    readonly WHATSAPP_APP_SECRET: string | undefined;
    readonly WHATSAPP_VERIFY_TOKEN: string | undefined;
    readonly WHATSAPP_ACCESS_TOKEN: string | undefined;
    readonly WHATSAPP_API_BASE_URL: string;
    readonly QUEUE_ATTEMPTS: number;
    readonly QUEUE_BACKOFF_MS: number;
    readonly ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: number;
  },
  ctx: z.RefinementCtx,
): void {
  const baseUrl = parseBaseUrl(env.WHATSAPP_API_BASE_URL);
  if (baseUrl === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['WHATSAPP_API_BASE_URL'],
      message: 'deve ser uma URL http(s) sem usuário, senha, query nem fragmento',
    });
  } else if (env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') {
    ctx.addIssue({
      code: 'custom',
      path: ['WHATSAPP_API_BASE_URL'],
      message: 'precisa ser https:// em produção (o token de envio iria em texto claro)',
    });
  }
  if (!env.WHATSAPP_ENABLED) return;

  for (const name of [
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
  ] as const) {
    if (env[name] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'obrigatória com WHATSAPP_ENABLED=true',
      });
    }
  }
  if (
    env.WHATSAPP_VERIFY_TOKEN !== undefined &&
    env.WHATSAPP_VERIFY_TOKEN.length < WHATSAPP_VERIFY_TOKEN_MIN_LENGTH
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['WHATSAPP_VERIFY_TOKEN'],
      message: `precisa ter no mínimo ${String(WHATSAPP_VERIFY_TOKEN_MIN_LENGTH)} caracteres`,
    });
  }
  // Tempo total de espera das retentativas (10 + 20 + 40 + 80 s com os padrões). Se não passar de
  // "em andamento", uma retentativa depois de queda do processo bateria em 409 até acabarem.
  const totalBackoffMs = env.QUEUE_BACKOFF_MS * (2 ** (env.QUEUE_ATTEMPTS - 1) - 1);
  if (totalBackoffMs <= env.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['QUEUE_BACKOFF_MS'],
      message: `QUEUE_BACKOFF_MS x (2^(QUEUE_ATTEMPTS - 1) - 1) = ${String(totalBackoffMs)} ms precisa ser maior que ATTENDANCE_IN_FLIGHT_TIMEOUT_MS (${String(env.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS)} ms), senão uma retentativa depois de queda do processo bateria em 409 até acabarem as tentativas`,
    });
  }
}

function parseBaseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    const plain =
      url.username === '' && url.password === '' && url.search === '' && url.hash === '';
    return (url.protocol === 'https:' || url.protocol === 'http:') && plain ? url : undefined;
  } catch {
    return undefined;
  }
}

export type Config = z.infer<typeof envSchema>;
