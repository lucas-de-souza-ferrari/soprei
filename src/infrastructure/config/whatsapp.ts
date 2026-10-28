import type { Config } from './env.schema.js';
import type { TrustProxySetting } from './trust-proxy.js';

/** Configuração do canal WhatsApp já validada (os segredos existem). Nunca vai para log. */
export interface WhatsappChannelConfig {
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly accessToken: string;
  readonly apiBaseUrl: string;
  readonly graphApiVersion: string;
  readonly sendTimeoutMs: number;
}

export interface QueueSettings {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly keepCompletedSeconds: number;
  readonly keepFailedSeconds: number;
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
  const { WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN } = config;
  if (
    WHATSAPP_APP_SECRET === undefined ||
    WHATSAPP_VERIFY_TOKEN === undefined ||
    WHATSAPP_ACCESS_TOKEN === undefined
  ) {
    throw new Error(
      'configuração do WhatsApp incompleta (a validação do schema deveria ter falhado)',
    );
  }
  return {
    appSecret: WHATSAPP_APP_SECRET,
    verifyToken: WHATSAPP_VERIFY_TOKEN,
    accessToken: WHATSAPP_ACCESS_TOKEN,
    apiBaseUrl: config.WHATSAPP_API_BASE_URL,
    graphApiVersion: config.WHATSAPP_GRAPH_API_VERSION,
    sendTimeoutMs: config.WHATSAPP_SEND_TIMEOUT_MS,
  };
}

export function queueSettings(config: Config): QueueSettings {
  return {
    attempts: config.QUEUE_ATTEMPTS,
    backoffMs: config.QUEUE_BACKOFF_MS,
    keepCompletedSeconds: config.QUEUE_KEEP_COMPLETED_SECONDS,
    keepFailedSeconds: config.QUEUE_KEEP_FAILED_SECONDS,
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
