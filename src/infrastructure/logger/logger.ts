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
  // Canal WhatsApp (spec 011): segredo do app, token de verificação do webhook e token de envio.
  'appSecret',
  'verifyToken',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
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
 * sai com `requestId`, `clientId`, `userId` e `operation`. Fora de requisição: `{}`.
 */
function contextMixin(_mergeObject: object, _level: number, logger: Logger): object {
  const context = getContext();
  if (context === undefined) return {};
  return {
    ...(loggerBindsRequestId(logger) ? {} : { requestId: context.requestId }),
    ...(context.clientId === undefined ? {} : { clientId: context.clientId }),
    ...(context.userId === undefined ? {} : { userId: context.userId }),
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
