import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ApiError, createApi, query } from './api';
import { sessionSchema } from './contracts';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response());
  }) as typeof fetch;
  return { calls, impl };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error;
  }
  assert.fail('deveria ter falhado');
}

describe('cliente da API do admin (spec 044, E3)', () => {
  it('GET vai a /api com o cookie da mesma origem, sem cache e com X-Soprei-App: admin', async () => {
    const fake = fakeFetch(() => Response.json({ email: 'dono@exemplo.test' }));
    const session = await createApi(fake.impl).get('/platform/auth/session', sessionSchema);
    assert.deepEqual(session, { email: 'dono@exemplo.test' });
    const [call] = fake.calls;
    assert.equal(call?.url, '/api/platform/auth/session');
    assert.equal(call?.init.method, 'GET');
    assert.equal(call?.init.credentials, 'same-origin');
    assert.equal(call?.init.cache, 'no-store');
    assert.deepEqual(call?.init.headers, { 'X-Soprei-App': 'admin' });
    assert.equal(call?.init.body, undefined);
  });

  it('POST manda JSON e o cabeçalho do app', async () => {
    const fake = fakeFetch(() => new Response(null, { status: 204 }));
    await createApi(fake.impl).post('/platform/companies/x/suspend', { reason: 'ABUSE' });
    const [call] = fake.calls;
    assert.equal(call?.init.method, 'POST');
    assert.deepEqual(call?.init.headers, {
      'Content-Type': 'application/json',
      'X-Soprei-App': 'admin',
    });
    assert.equal(call?.init.body, '{"reason":"ABUSE"}');
  });

  it('erro: só o status e o error.code; o texto do servidor é ignorado', async () => {
    const fake = fakeFetch(() =>
      Response.json(
        { error: { code: 'UNAUTHORIZED', message: 'texto que não aparece', requestId: 'r' } },
        { status: 401 },
      ),
    );
    const error = await rejection(createApi(fake.impl).get('/platform/overview', sessionSchema));
    assert.equal(error.status, 401);
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.equal(error.message.includes('texto que não aparece'), false);
  });

  it('corpo de erro fora do formato não vira código', async () => {
    const fake = fakeFetch(() =>
      Response.json({ error: { code: 'texto livre!' } }, { status: 500 }),
    );
    const error = await rejection(createApi(fake.impl).post('/platform/auth/logout'));
    assert.equal(error.status, 500);
    assert.equal(error.code, undefined);
  });

  it('resposta fora do contrato e falha de rede viram erros próprios', async () => {
    const wrong = fakeFetch(() => Response.json({ nada: true }));
    const invalid = await rejection(
      createApi(wrong.impl).get('/platform/auth/session', sessionSchema),
    );
    assert.deepEqual([invalid.status, invalid.code], [0, 'INVALID_RESPONSE']);
    const down = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const network = await rejection(
      createApi(down.impl).get('/platform/auth/session', sessionSchema),
    );
    assert.deepEqual([network.status, network.code], [0, 'NETWORK']);
  });

  it('query: só valores definidos e não vazios, codificados', () => {
    assert.equal(
      query({ status: 'active', q: 'padaria & cia', cursor: undefined, x: '' }),
      '?status=active&q=padaria+%26+cia',
    );
    assert.equal(query({ a: undefined }), '');
  });
});
