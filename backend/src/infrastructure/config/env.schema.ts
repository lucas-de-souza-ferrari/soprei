import { z } from 'zod';
import { SCHEDULE_AI_TURN_TIMEOUT_MS } from '../../domain/schedule-ai.js';
import { parseCredentialKeys } from '../security/aes-gcm-credential-cipher.js';
import { isValidSmtpHost } from './email.js';
import { parseTrustProxy, type TrustProxySetting } from './trust-proxy.js';

/** Mínimo do `JWT_SECRET` (spec 007): 32 caracteres, ou seja, 256 bits para o HS256. */
/** Folga somada à espera do worker no encerramento (spec 034). */
export const WORKER_CLOSE_MARGIN_MS = 5_000;

/**
 * Quanto o worker espera os jobs ativos no encerramento (spec 034): o turno mais longo possível
 * (prazo do modelo, ou o do turno com ferramentas da 028 quando ligado) mais o envio ao canal e uma
 * folga. Derivado da config, para não cortar um turno que ainda está dentro do prazo.
 */
export function workerCloseTimeoutMs(env: {
  readonly LLM_TIMEOUT_MS: number;
  readonly WHATSAPP_SEND_TIMEOUT_MS: number;
  readonly SCHEDULE_AI_ENABLED: boolean;
}): number {
  const turnMs = env.SCHEDULE_AI_ENABLED
    ? Math.max(env.LLM_TIMEOUT_MS, SCHEDULE_AI_TURN_TIMEOUT_MS)
    : env.LLM_TIMEOUT_MS;
  return turnMs + env.WHATSAPP_SEND_TIMEOUT_MS + WORKER_CLOSE_MARGIN_MS;
}

/**
 * Folga do pool do banco além dos jobs do canal (spec 034): conexões para as requisições HTTP e as
 * tarefas periódicas enquanto todos os jobs estão ativos.
 */
export const DB_POOL_QUEUE_HEADROOM = 5;
export const JWT_SECRET_MIN_LENGTH = 32;
export const METRICS_TOKEN_MIN_LENGTH = 32;

/** Provedores de LLM disponíveis: `mock` (testes e dev offline) e `anthropic` (spec 014). */
export const LLM_PROVIDERS = ['mock', 'anthropic'] as const;

/** Modelo padrão do provedor Anthropic (spec 014): Claude Haiku 5.5. */
export const DEFAULT_LLM_MODEL = 'claude-haiku-5-5';
/** Esforço de raciocínio do modelo (`output_config.effort`): `low` basta para atendimento por chat. */
export const LLM_EFFORTS = ['low', 'medium', 'high'] as const;
/** Mínimo da chave da Anthropic (as reais têm dezenas de caracteres). */
export const ANTHROPIC_API_KEY_MIN_LENGTH = 20;
/** Formato do id do modelo; fechado para o valor não virar caminho nem cabeçalho estranho. */
const LLM_MODEL_PATTERN = /^[a-z0-9.-]{1,64}$/;

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
/** Mínimo conservador do segredo do app e do token de envio (os reais têm dezenas de caracteres). */
export const WHATSAPP_SECRET_MIN_LENGTH = 16;
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
    ACCOUNTS_ENABLED: booleanLiteral(false),
    APP_ORIGIN: optionalSecret,
    // SMTP genérico (spec 019). Host, porta e remetente são obrigatórios só com ACCOUNTS_ENABLED=true.
    EMAIL_PROVIDER_HOST: optionalSecret.refine(
      (value) => value === undefined || isValidSmtpHost(value),
      'deve ser hostname ou IP, sem esquema, caminho, porta, espaço nem @',
    ),
    EMAIL_PROVIDER_PORT: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(65535).optional(),
    ),
    EMAIL_PROVIDER_SECURE: z.preprocess(emptyAsUndefined, booleanLiteral(false)),
    EMAIL_PROVIDER_FROM: optionalSecret.refine(
      (value) => value === undefined || z.email().safeParse(value).success,
      'e-mail inválido',
    ),
    EMAIL_PROVIDER_USER: optionalSecret,
    EMAIL_PROVIDER_PSWD: optionalSecret,
    // Expurgo de contas nunca confirmadas (spec 021): retenção em dias e intervalo da varredura (0 desliga).
    ACCOUNT_UNVERIFIED_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    ACCOUNT_PURGE_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string({ error: 'variável obrigatória ausente' })
      .regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgresql://'),
    REDIS_URL: z
      .string({ error: 'variável obrigatória ausente' })
      .regex(/^rediss?:\/\//, 'deve ser uma URL redis:// ou rediss://'),
    // Com o canal ligado precisa ser >= QUEUE_CONCURRENCY + DB_POOL_QUEUE_HEADROOM (spec 034).
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1).max(3_600_000).default(30_000),
    DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(5_000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(30_000),
    // Autenticação (spec 007). `JWT_SECRET` é obrigatória em todos os ambientes e nunca vai a log.
    // A antiga chave estática de administração foi removida: se ainda estiver no ambiente, é ignorada.
    JWT_SECRET: z
      .string({ error: 'variável obrigatória ausente' })
      .min(
        JWT_SECRET_MIN_LENGTH,
        `precisa ter no mínimo ${String(JWT_SECRET_MIN_LENGTH)} caracteres`,
      ),
    JWT_ISSUER: z.preprocess(emptyAsUndefined, z.string().min(1).max(200).default('soprei')),
    JWT_AUDIENCE: z.preprocess(emptyAsUndefined, z.string().min(1).max(200).default('soprei-api')),
    AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3_600).max(2_592_000).default(604_800),
    AUTH_SESSION_MAX_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
    AUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
    AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).max(20).default(5),
    AUTH_LOGIN_LOCK_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    AUTH_REDIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(10_000).default(500),
    AUTH_REDIS_PREFIX: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9:_-]{1,128}$/, 'letras, dígitos, ":", "_" e "-" (até 128)')
        .default('soprei:auth:'),
    ),
    // Token de GET /metrics (spec 004). Sem ele a rota não existe (404); vazia vale como ausente.
    METRICS_TOKEN: z
      .string()
      .optional()
      .transform((value) => (value === '' ? undefined : value)),
    // Atendimento (spec 010). Provedor de LLM e prazo máximo de uma chamada ao modelo.
    LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('mock'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(15_000),
    // Ferramentas de agenda da IA (spec 028). Chave global, desligada por padrão: ligada, a IA pode
    // consultar os horários livres por ferramenta (E1; marcar, cancelar e remarcar vêm nas etapas seguintes).
    SCHEDULE_AI_ENABLED: booleanLiteral(false),
    // Planos e assinaturas (spec 031). Chave global, desligada por padrão: desligada, NADA é cobrado, limitado nem
    // medido (o comportamento é o de antes). O catálogo e os preços ficam no banco, nunca em variável de ambiente.
    BILLING_ENABLED: booleanLiteral(false),
    // Gate do modo "o Soprei paga a Meta" (spec 031, D0): só liga depois de o E0 confirmar a linha de crédito.
    SOPREI_PAYS_META_ENABLED: booleanLiteral(false),
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(5),
    BILLING_TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    BILLING_TRIAL_TOKENS: z.coerce.number().int().min(1).max(100_000_000).default(300_000),
    // Checkout da InfinitePay (spec 031, E3). Flag propria, desligada por padrao: com ela desligada nao existe rota
    // de pedido, webhook nem reconciliacao, e nenhuma variavel INFINITEPAY_* e exigida. A chave nunca vai a log.
    CHECKOUT_ENABLED: booleanLiteral(false),
    INFINITEPAY_API_KEY: optionalSecret,
    INFINITEPAY_HANDLE: optionalSecret,
    INFINITEPAY_API_BASE_URL: z.preprocess(
      emptyAsUndefined,
      z.url().default('https://api.checkout.infinitepay.io'),
    ),
    INFINITEPAY_WEBHOOK_BASE_URL: optionalSecret,
    BILLING_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(8_000),
    // Host do link de pagamento aceito (o adaptador recusa qualquer outro): padrão o do exemplo da documentação.
    INFINITEPAY_CHECKOUT_HOST: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9.-]{1,253}$/, 'deve ser só o nome do host')
        .default('checkout.infinitepay.com.br'),
    ),
    // LGPD: o e-mail da conta só vai ao provedor se o dono confirmar (decisão do dono). Padrão false.
    CHECKOUT_SEND_CUSTOMER_EMAIL: booleanLiteral(false),
    // Reconciliação de pagamentos: timer PRÓPRIO (minutos; 0 desliga só ela; independe do expurgo de contas).
    BILLING_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1_440).default(10),
    // Avisos de cobrança por e-mail (E5): tarefa própria (minutos; 0 desliga só ela). Só vale com BILLING_ENABLED e
    // CHECKOUT_ENABLED (sem como pagar, não há o que avisar).
    BILLING_NOTICE_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1_440).default(60),
    // Provedor Anthropic (spec 014). A chave só é exigida com `LLM_PROVIDER=anthropic` e nunca vai
    // a log, métrica, erro nem resposta. `ANTHROPIC_BASE_URL` existe para os testes (servidor falso).
    ANTHROPIC_API_KEY: optionalSecret,
    ANTHROPIC_BASE_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
    LLM_MODEL: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(LLM_MODEL_PATTERN, 'deve casar com ^[a-z0-9.-]{1,64}$')
        .default(DEFAULT_LLM_MODEL),
    ),
    LLM_EFFORT: z.preprocess(emptyAsUndefined, z.enum(LLM_EFFORTS).default('low')),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8_192).default(1_024),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
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
    // Perfis de autenticação (spec 007): login e refresh/logout. Fail-closed (Redis fora: 503).
    RATE_LIMIT_LOGIN_MAX: rateLimitMax(10),
    RATE_LIMIT_LOGIN_WINDOW_SECONDS: rateLimitWindowSeconds(900),
    RATE_LIMIT_REFRESH_MAX: rateLimitMax(60),
    RATE_LIMIT_REFRESH_WINDOW_SECONDS: rateLimitWindowSeconds(900),
    // Prazo de cada comando da conexão Redis dedicada ao limiter; estourou: fail-open.
    RATE_LIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(10_000).default(250),
    // Canal WhatsApp (spec 011). Opt-in: sem `WHATSAPP_ENABLED=true` as rotas do webhook não existem.
    WHATSAPP_ENABLED: z.preprocess(emptyAsUndefined, booleanLiteral(false)),
    WHATSAPP_APP_SECRET: optionalSecret,
    WHATSAPP_VERIFY_TOKEN: optionalSecret,
    // Token global de transição (spec 015): só para empresas `LEGACY` (número gravado antes da 015 e
    // sem conexão própria). Opcional; quando nenhuma empresa estiver `LEGACY`, basta apagá-la.
    WHATSAPP_ACCESS_TOKEN: optionalSecret,
    // `app_id` esperado no `debug_token` de todo token de empresa (spec 015); dígitos.
    WHATSAPP_APP_ID: z.preprocess(emptyAsUndefined, z.string().optional()),
    // Chaves de cifra das credenciais por empresa (spec 015): `keyId:<32 bytes base64url>,...`.
    CHANNEL_CREDENTIALS_KEYS: optionalSecret,
    CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: z.preprocess(emptyAsUndefined, z.string().optional()),
    // Embedded Signup (spec 023): `config_id` público da configuração de login da Meta. Opcional; sem ele o
    // Embedded Signup fica indisponível no site (o resto do canal segue). Exige o canal ligado.
    WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: z.preprocess(emptyAsUndefined, z.string().optional()),
    // Formulário avançado do site (spec 023): conectar com token digitado. Só desenvolvimento e demonstração.
    CHANNEL_MANUAL_CONNECT_ENABLED: z.preprocess(emptyAsUndefined, booleanLiteral(false)),
    WHATSAPP_API_BASE_URL: z.preprocess(
      emptyAsUndefined,
      z.url().default('https://graph.facebook.com'),
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
    // Jobs processados ao mesmo tempo pelo worker (spec 034). A ordem das mensagens de um contato vem
    // do instante de recebimento no webhook, não da fila; 1 reproduz o comportamento antigo.
    QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    // Prazo global do desligamento gracioso (spec 034): passou disso, o processo sai com código 1.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
    // Agrupamento de mensagens rápidas do canal (spec 013). Janela deslizante com teto de espera;
    // `CHANNEL_BATCH_WINDOW_MS=0` desliga a espera. Só valem com o canal habilitado.
    CHANNEL_BATCH_WINDOW_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    CHANNEL_BATCH_MAX_WAIT_MS: z.coerce.number().int().min(0).max(300_000).default(20_000),
    CHANNEL_BATCH_MAX_MESSAGES: z.coerce.number().int().min(1).max(50).default(10),
    CHANNEL_BATCH_MAX_CHARS: z.coerce.number().int().min(1).max(24_000).default(8_000),
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
    if (env.ACCOUNTS_ENABLED) {
      for (const key of [
        'APP_ORIGIN',
        'EMAIL_PROVIDER_HOST',
        'EMAIL_PROVIDER_PORT',
        'EMAIL_PROVIDER_FROM',
      ] as const) {
        if (env[key] === undefined)
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'obrigatória com ACCOUNTS_ENABLED=true',
          });
      }
      if (Boolean(env.EMAIL_PROVIDER_USER) !== Boolean(env.EMAIL_PROVIDER_PSWD))
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_PROVIDER_USER'],
          message:
            'EMAIL_PROVIDER_USER e EMAIL_PROVIDER_PSWD devem vir juntas ou ficar ambas vazias',
        });
      if (env.APP_ORIGIN) {
        try {
          const origin = new URL(env.APP_ORIGIN);
          if (
            !['http:', 'https:'].includes(origin.protocol) ||
            origin.origin !== env.APP_ORIGIN ||
            (env.NODE_ENV === 'production' && origin.protocol !== 'https:')
          )
            throw new Error('origin');
        } catch {
          ctx.addIssue({
            code: 'custom',
            path: ['APP_ORIGIN'],
            message: 'origem HTTP(S) exata, HTTPS em produção',
          });
        }
      }
    }
    // `true` confia em toda a cadeia de X-Forwarded-For: o chamador escolhe o IP e escapa do limite.
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'não pode ser "true" em produção (o chamador escolheria o próprio IP); liste os IPs/CIDRs dos proxies, ex.: 127.0.0.1,::1',
      });
    }
    if (env.NODE_ENV === 'production' && !env.RATE_LIMIT_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_ENABLED'],
        message: 'não pode ser "false" em produção (a proteção contra abuso ficaria desligada)',
      });
    }
    // A cobrança vive nas rotas e na sessão da conta: sem contas globais ela não tem como funcionar.
    if (env.BILLING_ENABLED && !env.ACCOUNTS_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_ENABLED'],
        message: 'exige ACCOUNTS_ENABLED=true',
      });
    }
    // O modo S depende da cobrança: a flag sozinha não tem efeito algum e é um erro de configuração.
    if (env.SOPREI_PAYS_META_ENABLED && !env.BILLING_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOPREI_PAYS_META_ENABLED'],
        message: 'exige BILLING_ENABLED=true',
      });
    }
    refineCheckout(env, ctx);
    refineWhatsapp(env, ctx);
    refineAnthropic(env, ctx);
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
    // Com as ferramentas de agenda o laço da IA pode durar `SCHEDULE_AI_TURN_TIMEOUT_MS`: a mesma regra.
    if (
      env.SCHEDULE_AI_ENABLED &&
      env.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS <= SCHEDULE_AI_TURN_TIMEOUT_MS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ATTENDANCE_IN_FLIGHT_TIMEOUT_MS'],
        message: `precisa ser maior que o prazo do turno com ferramentas (${String(SCHEDULE_AI_TURN_TIMEOUT_MS)} ms) com SCHEDULE_AI_ENABLED=true`,
      });
    }
    // O teto absoluto da sessão não pode ser menor que o prazo ocioso (senão o ocioso nunca valeria).
    if (env.AUTH_SESSION_MAX_SECONDS < env.AUTH_REFRESH_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SESSION_MAX_SECONDS'],
        message: `precisa ser maior ou igual a AUTH_REFRESH_TTL_SECONDS (${String(env.AUTH_REFRESH_TTL_SECONDS)} s)`,
      });
    }
  });

/** Regras do provedor Anthropic (spec 014). */
function refineAnthropic(
  env: {
    readonly NODE_ENV: 'development' | 'test' | 'production';
    readonly LLM_PROVIDER: (typeof LLM_PROVIDERS)[number];
    readonly ANTHROPIC_API_KEY: string | undefined;
    readonly ANTHROPIC_BASE_URL?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (env.ANTHROPIC_BASE_URL !== undefined) {
    const baseUrl = parseBaseUrl(env.ANTHROPIC_BASE_URL);
    if (baseUrl === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_BASE_URL'],
        message: 'deve ser uma URL http(s) sem usuário, senha, query nem fragmento',
      });
    } else if (env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_BASE_URL'],
        message: 'precisa ser https:// em produção (a chave iria em texto claro)',
      });
    }
  }
  if (env.LLM_PROVIDER !== 'anthropic') return;
  if (env.ANTHROPIC_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message: 'obrigatória com LLM_PROVIDER=anthropic',
    });
  } else if (env.ANTHROPIC_API_KEY.length < ANTHROPIC_API_KEY_MIN_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message: `precisa ter no mínimo ${String(ANTHROPIC_API_KEY_MIN_LENGTH)} caracteres`,
    });
  }
}

/** Regras do checkout da InfinitePay (spec 031, E3): exigências só valem com CHECKOUT_ENABLED=true. */
function refineCheckout(
  env: {
    readonly NODE_ENV: string;
    readonly BILLING_ENABLED: boolean;
    readonly CHECKOUT_ENABLED: boolean;
    readonly INFINITEPAY_API_KEY?: string | undefined;
    readonly INFINITEPAY_HANDLE?: string | undefined;
    readonly INFINITEPAY_API_BASE_URL: string;
    readonly INFINITEPAY_WEBHOOK_BASE_URL?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const baseUrl = parseBaseUrl(env.INFINITEPAY_API_BASE_URL);
  if (baseUrl === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['INFINITEPAY_API_BASE_URL'],
      message: 'deve ser uma URL http(s) sem usuário, senha, query nem fragmento',
    });
  } else if (env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') {
    ctx.addIssue({
      code: 'custom',
      path: ['INFINITEPAY_API_BASE_URL'],
      message: 'precisa ser https:// em produção (a API Key iria em texto claro)',
    });
  }
  if (!env.CHECKOUT_ENABLED) return;
  if (!env.BILLING_ENABLED) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHECKOUT_ENABLED'],
      message: 'exige BILLING_ENABLED=true',
    });
  }
  for (const name of [
    'INFINITEPAY_API_KEY',
    'INFINITEPAY_HANDLE',
    'INFINITEPAY_WEBHOOK_BASE_URL',
  ] as const) {
    if (env[name] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'obrigatória com CHECKOUT_ENABLED=true',
      });
    }
  }
  if (env.INFINITEPAY_API_KEY !== undefined && env.INFINITEPAY_API_KEY.length < 16) {
    ctx.addIssue({
      code: 'custom',
      path: ['INFINITEPAY_API_KEY'],
      message: 'precisa ter no mínimo 16 caracteres',
    });
  }
  if (
    env.INFINITEPAY_HANDLE !== undefined &&
    !/^[A-Za-z0-9._-]{1,64}$/.test(env.INFINITEPAY_HANDLE)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['INFINITEPAY_HANDLE'],
      message: 'deve ser a InfiniteTag sem o cifrão (letras, dígitos, ponto, hífen e sublinhado)',
    });
  }
  if (env.INFINITEPAY_WEBHOOK_BASE_URL !== undefined) {
    const url = parseBaseUrl(env.INFINITEPAY_WEBHOOK_BASE_URL);
    if (
      url === undefined ||
      url.pathname !== '/' ||
      env.INFINITEPAY_WEBHOOK_BASE_URL.endsWith('/')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['INFINITEPAY_WEBHOOK_BASE_URL'],
        message:
          'deve ser só a origem pública do backend (http(s)://host[:porta], sem caminho nem barra final)',
      });
    } else if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['INFINITEPAY_WEBHOOK_BASE_URL'],
        message: 'precisa ser https:// em produção',
      });
    }
  }
}

/** Regras do canal WhatsApp (spec 011): só valem com `WHATSAPP_ENABLED=true`, salvo a URL base. */
function refineWhatsapp(
  env: {
    readonly NODE_ENV: 'development' | 'test' | 'production';
    readonly WHATSAPP_ENABLED: boolean;
    readonly WHATSAPP_APP_SECRET: string | undefined;
    readonly WHATSAPP_VERIFY_TOKEN: string | undefined;
    readonly WHATSAPP_ACCESS_TOKEN: string | undefined;
    readonly WHATSAPP_APP_ID?: string | undefined;
    readonly WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID?: string | undefined;
    readonly CHANNEL_MANUAL_CONNECT_ENABLED?: boolean;
    readonly CHANNEL_CREDENTIALS_KEYS?: string | undefined;
    readonly CHANNEL_CREDENTIALS_ACTIVE_KEY_ID?: string | undefined;
    readonly WHATSAPP_API_BASE_URL: string;
    readonly QUEUE_ATTEMPTS: number;
    readonly QUEUE_BACKOFF_MS: number;
    readonly QUEUE_CONCURRENCY: number;
    readonly DB_POOL_MAX: number;
    readonly SHUTDOWN_TIMEOUT_MS: number;
    readonly LLM_TIMEOUT_MS: number;
    readonly WHATSAPP_SEND_TIMEOUT_MS: number;
    readonly SCHEDULE_AI_ENABLED: boolean;
    readonly ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: number;
    readonly CHANNEL_BATCH_WINDOW_MS: number;
    readonly CHANNEL_BATCH_MAX_WAIT_MS: number;
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
  if (env.NODE_ENV === 'production' && env.CHANNEL_MANUAL_CONNECT_ENABLED === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHANNEL_MANUAL_CONNECT_ENABLED'],
      message: 'não pode ser "true" em produção (o token da Meta seria digitado no navegador)',
    });
  }
  if (env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID !== undefined) {
    if (!/^[0-9]{1,32}$/.test(env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'],
        message: 'deve ter de 1 a 32 dígitos',
      });
    }
    if (!env.WHATSAPP_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'],
        message: 'exige WHATSAPP_ENABLED=true',
      });
    }
  }
  if (!env.WHATSAPP_ENABLED) return;

  for (const name of [
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_ID',
    'CHANNEL_CREDENTIALS_KEYS',
    'CHANNEL_CREDENTIALS_ACTIVE_KEY_ID',
  ] as const) {
    if (env[name] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'obrigatória com WHATSAPP_ENABLED=true',
      });
    }
  }
  if (env.WHATSAPP_APP_ID !== undefined && !/^[0-9]{1,32}$/.test(env.WHATSAPP_APP_ID)) {
    ctx.addIssue({
      code: 'custom',
      path: ['WHATSAPP_APP_ID'],
      message: 'deve ter de 1 a 32 dígitos',
    });
  }
  refineCredentialKeys(env, ctx);
  for (const name of ['WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN'] as const) {
    const value = env[name];
    if (value !== undefined && value.length < WHATSAPP_SECRET_MIN_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `precisa ter no mínimo ${String(WHATSAPP_SECRET_MIN_LENGTH)} caracteres`,
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
  // Cada job ativo pode segurar uma conexão; o resto do pool atende o HTTP e as tarefas periódicas.
  if (env.DB_POOL_MAX < env.QUEUE_CONCURRENCY + DB_POOL_QUEUE_HEADROOM) {
    ctx.addIssue({
      code: 'custom',
      path: ['DB_POOL_MAX'],
      message: `DB_POOL_MAX (${String(env.DB_POOL_MAX)}) precisa ser maior ou igual a QUEUE_CONCURRENCY (${String(env.QUEUE_CONCURRENCY)}) + ${String(DB_POOL_QUEUE_HEADROOM)}, senão os jobs do canal esgotam o pool do banco`,
    });
  }
  // O desligamento espera os jobs ativos (um turno inteiro: modelo + envio); com prazo global menor
  // que isso, todo deploy cortaria respostas em andamento.
  const workerCloseMs = workerCloseTimeoutMs(env);
  if (env.SHUTDOWN_TIMEOUT_MS <= workerCloseMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['SHUTDOWN_TIMEOUT_MS'],
      message: `SHUTDOWN_TIMEOUT_MS (${String(env.SHUTDOWN_TIMEOUT_MS)} ms) precisa ser maior que a espera do worker no encerramento (${String(workerCloseMs)} ms = prazo do turno + WHATSAPP_SEND_TIMEOUT_MS + ${String(WORKER_CLOSE_MARGIN_MS)} ms)`,
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
  // O teto de espera conta desde a primeira mensagem pendente; menor que a janela, ele cortaria a
  // espera de qualquer mensagem isolada e a janela deslizante deixaria de existir.
  if (env.CHANNEL_BATCH_MAX_WAIT_MS < env.CHANNEL_BATCH_WINDOW_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHANNEL_BATCH_MAX_WAIT_MS'],
      message: `precisa ser maior ou igual a CHANNEL_BATCH_WINDOW_MS (${String(env.CHANNEL_BATCH_WINDOW_MS)} ms)`,
    });
  }
}

/** Chaves de cifra (spec 015): nenhuma mensagem inclui o valor de uma chave. */
function refineCredentialKeys(
  env: {
    readonly CHANNEL_CREDENTIALS_KEYS?: string | undefined;
    readonly CHANNEL_CREDENTIALS_ACTIVE_KEY_ID?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (env.CHANNEL_CREDENTIALS_KEYS === undefined) return;
  const parsed = parseCredentialKeys(env.CHANNEL_CREDENTIALS_KEYS);
  if (!parsed.ok) {
    ctx.addIssue({ code: 'custom', path: ['CHANNEL_CREDENTIALS_KEYS'], message: parsed.message });
    return;
  }
  const active = env.CHANNEL_CREDENTIALS_ACTIVE_KEY_ID;
  if (active !== undefined && !parsed.keys.some((entry) => entry.keyId === active)) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHANNEL_CREDENTIALS_ACTIVE_KEY_ID'],
      message: 'precisa ser um dos keyId de CHANNEL_CREDENTIALS_KEYS',
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
