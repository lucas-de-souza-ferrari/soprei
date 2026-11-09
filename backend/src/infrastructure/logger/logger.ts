import { type DestinationStream, pino, type Logger, type LoggerOptions } from 'pino';
import { getContext } from '../../shared/request-context/index.js';
import type { Config } from '../config/index.js';

type LoggerConfig = Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>;

const REDACTED_KEYS = [
  'authorization',
  'cookie',
  'password',
  'refreshToken',
  'accessToken',
  'token',
  'apiKey',
  // Autenticação (spec 007): senha, hash, segredo do JWT e e-mail (dado pessoal) nunca em log.
  'passwordHash',
  'newPassword',
  'currentPassword',
  'JWT_SECRET',
  'email',
  'EMAIL_PROVIDER_USER',
  'EMAIL_PROVIDER_PSWD',
  'verificationHash',
  'resetHash',
  'verificationToken',
  'set-cookie',
  // Canal WhatsApp (spec 011): segredo do app, token de verificação do webhook e token de envio.
  'appSecret',
  'verifyToken',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  // Credenciais por empresa (spec 015): token cifrado, chaves de cifra, code do Embedded Signup.
  'tokenCiphertext',
  'clientSecret',
  // `oauthCode` (não `code`, que mascararia códigos de erro úteis): code do Embedded Signup e o PIN
  // de registro do número, sempre com estes nomes.
  'oauthCode',
  'registrationPin',
  'registrationPinCiphertext',
  'CHANNEL_CREDENTIALS_KEYS',
  // Checkout (spec 031, E3): a API Key da InfinitePay, o link de pagamento e as referencias da transacao.
  'INFINITEPAY_API_KEY',
  'checkoutUrl',
  'providerTransactionRef',
  'webhookToken',
  'transactionNsu',
  'invoiceSlug',
  'receiptUrl',
  // Convites (spec 025): o token do link e o próprio link nunca vão a log.
  'invitationToken',
  'inviteLink',
] as const;

/**
 * Segredos nunca vão para o log (valor `[Redacted]`): cada chave sensível em nível raiz e um
 * nível abaixo (`*.password`...), mais os cabeçalhos de requisição mais comuns.
 */
export const REDACT_PATHS: readonly string[] = [
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
];

/** Loggers (filhos do Fastify) que já carregam `requestId` nos bindings: o mixin não repete. */
const bindsRequestId = new WeakMap<object, boolean>();

function loggerBindsRequestId(logger: Logger): boolean {
  let binds = bindsRequestId.get(logger);
  if (binds === undefined) {
    binds = Object.hasOwn(logger.bindings(), 'requestId');
    bindsRequestId.set(logger, binds);
  }
  return binds;
}

/**
 * Contexto da requisição atual (AsyncLocalStorage) para o log. Assim, qualquer log feito
 * durante a requisição, inclusive de um service que usa o logger raiz e não `request.log`,
 * sai com `requestId`, `companyId`, `actorId` e `operation`. Fora de requisição: `{}`.
 */
function contextMixin(_mergeObject: object, _level: number, logger: Logger): object {
  const context = getContext();
  if (context === undefined) return {};
  return {
    ...(loggerBindsRequestId(logger) ? {} : { requestId: context.requestId }),
    ...(context.companyId === undefined ? {} : { companyId: context.companyId }),
    ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
    ...(context.operation === undefined ? {} : { operation: context.operation }),
  };
}

/** JSON estruturado em produção e nos testes; `pino-pretty` só em desenvolvimento. */
export function createLoggerOptions(config: LoggerConfig, useTransport = true): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    mixin: contextMixin,
    redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
    ...(useTransport && config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };
}

/**
 * `destination` é opcional e serve aos testes capturarem as linhas; quando informado, vale
 * no lugar do transporte de desenvolvimento (o Pino aceita só um dos dois).
 */
export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  if (destination === undefined) return pino(createLoggerOptions(config));
  return pino(createLoggerOptions(config, false), destination);
}
