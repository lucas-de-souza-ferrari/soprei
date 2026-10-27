import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { buildTestServer } from '../infrastructure/http/test-server.js';
import { bearerAuthHook } from './bearer-auth.hook.js';

const TOKEN = `t-${randomUUID()}-${randomUUID()}`;

async function call(
  token: string | undefined,
  authorization: string | undefined,
  onRejected?: (request: FastifyRequest) => void,
): Promise<{ status: number; rejectedWith: string[] }> {
  const rejectedWith: string[] = [];
  const app = buildTestServer();
  app.get(
    '/protegida',
    {
      onRequest: bearerAuthHook(token, (request) => {
        rejectedWith.push(request.url);
        onRejected?.(request);
      }),
    },
    () => ({ ok: true }),
  );
  await app.ready();
  const response = await app.inject({
    method: 'GET',
    url: '/protegida',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
  await app.close();
  return { status: response.statusCode, rejectedWith };
}

describe('bearerAuthHook', () => {
  it('aceita o token certo e não chama onRejected', async () => {
    const result = await call(TOKEN, `Bearer ${TOKEN}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.rejectedWith, []);
  });

  it('o esquema Bearer não diferencia maiúsculas, o token sim', async () => {
    assert.equal((await call(TOKEN, `bearer ${TOKEN}`)).status, 200);
    assert.equal((await call(TOKEN, `Bearer ${TOKEN.toUpperCase()}`)).status, 401);
  });

  it('401 e onRejected sem cabeçalho, com esquema errado, token errado ou token vazio', async () => {
    for (const header of [undefined, '', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, 'Bearer ', TOKEN]) {
      const result = await call(TOKEN, header);
      assert.equal(result.status, 401, String(header));
      assert.deepEqual(result.rejectedWith, ['/protegida']);
    }
  });

  it('sem token configurado (ou vazio) toda requisição recebe 401', async () => {
    for (const token of [undefined, '']) {
      assert.equal((await call(token, `Bearer ${TOKEN}`)).status, 401);
      assert.equal((await call(token, 'Bearer ')).status, 401);
    }
  });
});
