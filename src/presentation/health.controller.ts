import type { FastifyPluginCallback } from 'fastify';

export const healthController: FastifyPluginCallback = (app, _options, done) => {
  app.get('/health', () => ({ status: 'ok' }));
  done();
};
