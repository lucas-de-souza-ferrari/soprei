import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ChannelProvisionError } from '../../../application/ports/channel-provisioner.js';
import { SecretString } from '../../../shared/types/index.js';
import { FakeGraphApi, FULL_SCOPES, graphError } from '../../../test-support/fake-graph-api.js';
import { WhatsappGraphAdminClient } from './whatsapp-graph-admin.client.js';

const APP_ID = '1234567890';
const APP_SECRET = 'segredo-do-app-de-teste-0123456789';
const TOKEN = new SecretString('EAAG-token-do-empresa-secreto');
const WABA = '555000111';

const graph = new FakeGraphApi();
before(async () => {
  await graph.start();
});
after(async () => {
  await graph.stop();
});
beforeEach(() => {
  graph.reset();
});

const client = (timeoutMs = 500): WhatsappGraphAdminClient =>
  new WhatsappGraphAdminClient({
    baseUrl: graph.baseUrl,
    graphApiVersion: 'v26.0',
    appId: APP_ID,
    appSecret: APP_SECRET,
    timeoutMs,
  });

function givenToken(): void {
  graph.addWaba(WABA, ['111', '222']);
  graph.addToken(TOKEN.reveal(), {
    appId: APP_ID,
    scopes: FULL_SCOPES,
    wabaIds: [WABA],
    expiresAt: 4_000_000_000,
  });
}

describe('WhatsappGraphAdminClient', () => {
  it('debug_token: resume app, escopos, WABAs e validade; token de app só em cabeçalho', async () => {
    givenToken();
    const result = await client().inspectToken(TOKEN);
    assert.ok(result.ok);
    assert.equal(result.value.isValid, true);
    assert.equal(result.value.appId, APP_ID);
    assert.deepEqual([...result.value.scopes].sort(), [...FULL_SCOPES].sort());
    assert.deepEqual(result.value.wabaTargetIds, [WABA]);
    assert.equal(result.value.expiresAt?.getTime(), 4_000_000_000 * 1000);
    const [request] = graph.requests;
    assert.equal(request?.headers.authorization, `Bearer ${APP_ID}|${APP_SECRET}`);
    assert.ok(!request.path.includes(APP_SECRET));
  });

  it('token desconhecido: is_valid false; sem granular_scopes: wabaTargetIds indefinido', async () => {
    const unknown = await client().inspectToken(new SecretString('EAAG-desconhecido'));
    assert.ok(unknown.ok);
    assert.equal(unknown.value.isValid, false);
    graph.addToken(TOKEN.reveal(), {
      appId: APP_ID,
      scopes: FULL_SCOPES,
      wabaIds: [WABA],
      granular: false,
    });
    const result = await client().inspectToken(TOKEN);
    assert.ok(result.ok);
    assert.equal(result.value.wabaTargetIds, undefined);
    assert.equal(result.value.expiresAt, null);
  });

  it('lista números, assina e desassina com o token da empresa em Authorization', async () => {
    givenToken();
    const numbers = await client().listPhoneNumberIds(WABA, TOKEN);
    assert.ok(numbers.ok);
    assert.deepEqual(numbers.value, ['111', '222']);
    assert.ok((await client().subscribeApp(WABA, TOKEN)).ok);
    assert.ok(graph.subscribed.has(WABA));
    assert.ok((await client().unsubscribeApp(WABA, TOKEN)).ok);
    assert.ok(!graph.subscribed.has(WABA));
    for (const request of graph.requests) {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN.reveal()}`);
      assert.ok(!request.path.includes(TOKEN.reveal()));
    }
  });

  it('erro: só operação, status, código e retentável; nunca o corpo da Meta (que ecoa o token)', async () => {
    givenToken();
    const cases: [number, number, boolean][] = [
      [401, 190, false],
      [400, 100, false],
      [429, 4, true],
      [500, 1, true],
    ];
    for (const [status, code, retryable] of cases) {
      graph.failOperation('phone_numbers', graphError(status, code));
      const result = await client().listPhoneNumberIds(WABA, TOKEN);
      assert.ok(!result.ok);
      assert.ok(result.error instanceof ChannelProvisionError);
      assert.equal(result.error.httpStatus, status);
      assert.equal(result.error.providerCode, code);
      assert.equal(result.error.retryable, retryable);
      const shown = JSON.stringify(result.error.context) + result.error.message;
      assert.ok(!shown.includes('texto da Meta') && !shown.includes(TOKEN.reveal()));
      assert.deepEqual(Object.keys(result.error.context).sort(), [
        'httpStatus',
        'operation',
        'providerCode',
        'reason',
        'retryable',
      ]);
    }
  });

  it('redirect não é seguido; corpo acima de 64 KiB é cortado; demora e queda viram erro retentável', async () => {
    givenToken();
    graph.failOperation('subscribe', { kind: 'respond', status: 302 });
    const redirect = await client().subscribeApp(WABA, TOKEN);
    assert.ok(!redirect.ok);
    assert.equal(redirect.error.httpStatus, 302);
    assert.equal(graph.requests.length, 1, 'nenhum segundo pedido');

    graph.failOperation('debug_token', { kind: 'flood', status: 200 });
    const flood = await client().inspectToken(TOKEN);
    assert.ok(!flood.ok);
    assert.equal(flood.error.reason, 'invalid_response');
    assert.ok(graph.floodBytesWritten < 5 * 1024 * 1024);

    graph.failOperation('phone_numbers', { kind: 'hang' });
    const slow = await client(150).listPhoneNumberIds(WABA, TOKEN);
    assert.ok(!slow.ok);
    assert.equal(slow.error.reason, 'timeout');
    assert.equal(slow.error.retryable, true);

    graph.failOperation('phone_numbers', { kind: 'drop' });
    const dropped = await client().listPhoneNumberIds(WABA, TOKEN);
    assert.ok(!dropped.ok);
    assert.equal(dropped.error.reason, 'network');
  });

  it('resposta fora do formato: invalid_response, não retentável', async () => {
    givenToken();
    graph.failOperation('subscribe', { kind: 'respond', status: 200, body: { success: false } });
    const result = await client().subscribeApp(WABA, TOKEN);
    assert.ok(!result.ok);
    assert.equal(result.error.reason, 'invalid_response');
    assert.equal(result.error.retryable, false);
  });

  it('troca do code: client_id, segredo e code na query (nunca em log), sem Authorization; code de uso único', async () => {
    graph.addCode('code-valido-123', 'EAAG-token-trocado-secreto');
    const first = await client().exchangeCode(new SecretString('code-valido-123'));
    assert.ok(first.ok);
    assert.equal(first.value.reveal(), 'EAAG-token-trocado-secreto');
    const [request] = graph.requests;
    assert.equal(request?.operation, 'oauth_token');
    assert.equal(request.query.client_id, APP_ID);
    assert.equal(request.query.client_secret, APP_SECRET);
    assert.equal(request.headers.authorization, undefined);
    const second = await client().exchangeCode(new SecretString('code-valido-123'));
    assert.ok(!second.ok);
    assert.equal(second.error.httpStatus, 400);
    assert.equal(second.error.retryable, false);
    const shown = JSON.stringify(second.error.context) + second.error.message;
    assert.ok(!shown.includes('code-valido-123') && !shown.includes(APP_SECRET));
    graph.addCode('code-velho', 'x', { expired: true });
    assert.ok(!(await client().exchangeCode(new SecretString('code-velho'))).ok);
  });

  it('register: PIN no corpo e token em Authorization; PIN diferente de número com 2FA vira erro 133005 sem corpo da Meta', async () => {
    givenToken();
    const pin = new SecretString('123456');
    assert.ok((await client().registerNumber('111', TOKEN, pin)).ok);
    const [request] = graph.requests;
    assert.equal(request?.headers.authorization, `Bearer ${TOKEN.reveal()}`);
    assert.deepEqual(request.body, { messaging_product: 'whatsapp', pin: '123456' });
    assert.ok(!request.path.includes('123456'));
    graph.setRegistered('222', '999999');
    const wrong = await client().registerNumber('222', TOKEN, pin);
    assert.ok(!wrong.ok);
    assert.equal(wrong.error.providerCode, 133005);
    assert.equal(wrong.error.retryable, false);
    assert.ok(!JSON.stringify(wrong.error.context).includes('123456'));
  });
});
