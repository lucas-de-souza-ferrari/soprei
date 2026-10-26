import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  TenantScopeError,
} from '../../shared/errors/index.js';
import { buildTestServer } from './test-server.js';

const SEGREDO = 'senha-do-banco-postgres://admin:123@10.0.0.5';

interface ErrorResponse {
  error: { code: string; message: string; requestId: string; details?: unknown[] };
}

describe('error handler central', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildTestServer();
    app.get('/test/not-found', () => {
      throw new NotFoundError('Cliente não encontrado', { context: { segredo: SEGREDO } });
    });
    app.get('/test/external', () => {
      throw new ExternalServiceError(`falha ao falar com ${SEGREDO}`);
    });
    app.post('/test/validation', (request) => {
      return z.object({ nome: z.string().min(1), idade: z.number() }).parse(request.body);
    });
    app.get('/test/conflict', () => {
      throw new ConflictError('Já existe um cliente com este slug', {
        context: { segredo: SEGREDO },
      });
    });
    app.get('/test/tenant-scope', () => {
      throw new TenantScopeError(`Operação findMany em Conversation sem escopo: ${SEGREDO}`, {
        context: { model: 'Conversation', operation: 'findMany', segredo: SEGREDO },
      });
    });
    app.get('/test/unexpected', () => {
      throw new Error(SEGREDO);
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('NotFoundError vira 404 em JSON sem stack nem context', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/not-found' });
    assert.equal(response.statusCode, 404);
    const body = response.json<ErrorResponse>();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Cliente não encontrado');
    assert.equal(typeof body.error.requestId, 'string');
    assert.ok(!response.body.includes('stack'));
    assert.ok(!response.body.includes(SEGREDO));
    assert.ok(!response.body.includes('.ts'));
  });

  it('erro de validação Zod vira 400 com os campos inválidos', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/validation',
      payload: { nome: '' },
    });
    assert.equal(response.statusCode, 400);
    const body = response.json<ErrorResponse>();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(body.error.details));
    assert.ok(body.error.details.length >= 1);
    assert.ok(!response.body.includes('stack'));
  });

  it('erro 5xx de domínio responde mensagem genérica, sem vazar a original', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/external' });
    assert.equal(response.statusCode, 502);
    const body = response.json<ErrorResponse>();
    assert.equal(body.error.code, 'EXTERNAL_SERVICE_ERROR');
    assert.ok(!response.body.includes(SEGREDO));
  });

  it('ConflictError vira 409 com a mensagem de negócio e sem o context', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/conflict' });
    assert.equal(response.statusCode, 409);
    const body = response.json<ErrorResponse>();
    assert.equal(body.error.code, 'CONFLICT');
    assert.equal(body.error.message, 'Já existe um cliente com este slug');
    assert.ok(!response.body.includes(SEGREDO));
  });

  it('TenantScopeError vira 500 genérico: não vaza model, operação, mensagem nem contexto', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/tenant-scope' });
    assert.equal(response.statusCode, 500);
    const body = response.json<ErrorResponse>();
    assert.equal(body.error.code, 'TENANT_SCOPE_ERROR');
    assert.equal(body.error.message, 'Erro interno do servidor');
    assert.ok(!response.body.includes(SEGREDO));
    assert.ok(!response.body.includes('Conversation'));
    assert.ok(!response.body.includes('findMany'));
    assert.ok(!response.body.includes('stack'));
  });

  it('erro inesperado vira 500 genérico sem vazar mensagem interna nem stack', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/unexpected' });
    assert.equal(response.statusCode, 500);
    const body = response.json<ErrorResponse>();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'Erro interno do servidor');
    assert.ok(!response.body.includes(SEGREDO));
    assert.ok(!response.body.includes('stack'));
    assert.ok(!response.body.includes('at '));
  });

  it('JSON malformado vira 400 genérico', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: '{nao-e-json',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json<ErrorResponse>().error.code, 'BAD_REQUEST');
  });

  it('rota inexistente vira 404 em JSON', async () => {
    const response = await app.inject({ method: 'GET', url: '/nao-existe' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<ErrorResponse>().error.code, 'NOT_FOUND');
  });
});
