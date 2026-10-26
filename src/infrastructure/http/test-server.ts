import type { FastifyInstance } from 'fastify';
import { createLogger } from '../logger/logger.js';
import { buildServer } from './server.js';

/** Servidor com log silencioso para os testes. */
export function buildTestServer(): FastifyInstance {
  return buildServer({ logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }) });
}
