import type { Config } from './env.schema.js';
import type { TrustProxySetting } from './trust-proxy.js';

/** Configuração do canal WhatsApp já validada (os segredos existem). Nunca vai para log. */
export interface WhatsappChannelConfig {
  readonly appSecret: string;
  readonly verifyToken: string;
  /** Token global de transição, só para empresas `LEGACY` (spec 015); pode não existir. */
  readonly legacyAccessToken: string | undefined;
  readonly appId: string;
  readonly credentialKeys: string;
  readonly credentialActiveKeyId: string;
  readonly apiBaseUrl: string;
  readonly graphApiVersion: string;
  readonly sendTimeoutMs: number;
  /** `config_id` público do Embedded Signup (spec 023); ausente = indisponível no site. */
  readonly embeddedSignupConfigId: string | undefined;
  /** Formulário avançado do site (spec 023); nunca em produção. */
  readonly manualConnectEnabled: boolean;
}

export interface QueueSettings {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly keepCompletedSeconds: number;
  readonly keepFailedSeconds: number;
  /** Quantos jobs o worker processa ao mesmo tempo (spec 034). Ausente = 1. */
  readonly concurrency?: number;
}

/** Agrupamento de mensagens rápidas do canal (spec 013). */
export interface BatchSettings {
  /** Espera sem mensagem nova antes de responder; 0 desliga a espera. */
  readonly windowMs: number;
  /** Teto de espera, contado desde a mais antiga mensagem pendente. */
  readonly maxWaitMs: number;
  /** Máximo de mensagens somadas numa resposta. */
  readonly maxMessages: number;
  /** Máximo de caracteres somados numa resposta (uma única mensagem maior segue sozinha). */
  readonly maxChars: number;
}

/**
 * Configuração do canal, ou `undefined` com `WHATSAPP_ENABLED=false`. A validação do schema
 * já garantiu os três segredos quando habilitado; se faltar algum aqui é erro de programação.
 */
export function whatsappChannelConfig(config: Config): WhatsappChannelConfig | undefined {
  if (!config.WHATSAPP_ENABLED) return undefined;
  const {
    WHATSAPP_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_APP_ID,
    CHANNEL_CREDENTIALS_KEYS,
    CHANNEL_CREDENTIALS_ACTIVE_KEY_ID,
  } = config;
  if (
    WHATSAPP_APP_SECRET === undefined ||
    WHATSAPP_VERIFY_TOKEN === undefined ||
    WHATSAPP_APP_ID === undefined ||
    CHANNEL_CREDENTIALS_KEYS === undefined ||
    CHANNEL_CREDENTIALS_ACTIVE_KEY_ID === undefined
  ) {
    throw new Error(
      'configuração do WhatsApp incompleta (a validação do schema deveria ter falhado)',
    );
  }
  return {
    appSecret: WHATSAPP_APP_SECRET,
    verifyToken: WHATSAPP_VERIFY_TOKEN,
    legacyAccessToken: WHATSAPP_ACCESS_TOKEN,
    appId: WHATSAPP_APP_ID,
    credentialKeys: CHANNEL_CREDENTIALS_KEYS,
    credentialActiveKeyId: CHANNEL_CREDENTIALS_ACTIVE_KEY_ID,
    apiBaseUrl: config.WHATSAPP_API_BASE_URL,
    graphApiVersion: config.WHATSAPP_GRAPH_API_VERSION,
    sendTimeoutMs: config.WHATSAPP_SEND_TIMEOUT_MS,
    embeddedSignupConfigId: config.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
    manualConnectEnabled: config.CHANNEL_MANUAL_CONNECT_ENABLED,
  };
}

export function queueSettings(config: Config): QueueSettings {
  return {
    attempts: config.QUEUE_ATTEMPTS,
    backoffMs: config.QUEUE_BACKOFF_MS,
    keepCompletedSeconds: config.QUEUE_KEEP_COMPLETED_SECONDS,
    keepFailedSeconds: config.QUEUE_KEEP_FAILED_SECONDS,
    concurrency: config.QUEUE_CONCURRENCY,
  };
}

/** Modo do `TRUST_PROXY` para o log de boot, sem IP algum. */
export function trustProxyMode(setting: TrustProxySetting): 'off' | 'all' | 'list' {
  if (setting === false) return 'off';
  return setting === true ? 'all' : 'list';
}

export function batchSettings(config: Config): BatchSettings {
  return {
    windowMs: config.CHANNEL_BATCH_WINDOW_MS,
    maxWaitMs: config.CHANNEL_BATCH_MAX_WAIT_MS,
    maxMessages: config.CHANNEL_BATCH_MAX_MESSAGES,
    maxChars: config.CHANNEL_BATCH_MAX_CHARS,
  };
}
