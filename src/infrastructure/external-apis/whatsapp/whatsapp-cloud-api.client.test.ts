import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MessageSendError } from '../../../application/ports/message-sender.js';
import { FakeGraphApi, graphError } from '../../../test-support/fake-graph-api.js';
import { keepEventLoopAlive } from '../../../test-support/keep-alive.js';
import { createMetrics } from '../../metrics/index.js';
import {
  isRetryableGraphFailure,
  WhatsappCloudApiClient,
  type WhatsappCloudApiClientOptions,
} from './whatsapp-cloud-api.client.js';

const TOKEN = 'EAAG-token-secreto-de-envio';
const PHONE_NUMBER_ID = '106540352242922';
const CONTACT = '5511999990000';
const SECRET_TEXT = 'texto-secreto-da-resposta';

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

function makeClient(
  overrides: Partial<WhatsappCloudApiClientOptions> = {},
): WhatsappCloudApiClient {
  return new WhatsappCloudApiClient({
    baseUrl: graph.baseUrl,
    graphApiVersion: 'v26.0',
    accessToken: TOKEN,
    timeoutMs: 2_000,
    ...overrides,
  });
}

const input = { phoneNumberId: PHONE_NUMBER_ID, to: CONTACT, text: SECRET_TEXT };

async function expectFailure(client: WhatsappCloudApiClient): Promise<MessageSendError> {
  const result = await client.sendText(input);
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof MessageSendError);
  return result.error;
}

describe('WhatsappCloudApiClient: requisição', () => {
  it('envia POST /<versão>/<phone_number_id>/messages com Bearer e o corpo de texto, e devolve o wamid', async () => {
    const result = await makeClient().sendText(input);

    assert.ok(result.ok);
    assert.match(result.value.channelMessageId, /^wamid\.FAKE\d+$/);
    assert.equal(graph.requests.length, 1);
    const [request] = graph.requests;
    assert.equal(request?.method, 'POST');
    assert.equal(request.path, `/v26.0/${PHONE_NUMBER_ID}/messages`);
    assert.equal(request.version, 'v26.0');
    assert.equal(request.phoneNumberId, PHONE_NUMBER_ID);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(String(request.headers['content-type']), /^application\/json/);
    assert.deepEqual(request.body, {
      messaging_product: 'whatsapp',
      to: CONTACT,
      type: 'text',
      text: { body: SECRET_TEXT },
    });
  });

  it('aceita a URL base com barra no fim e a versão configurada', async () => {
    const client = makeClient({ baseUrl: `${graph.baseUrl}///`, graphApiVersion: 'v24.0' });
    assert.ok((await client.sendText(input)).ok);
    assert.equal(graph.requests[0]?.path, `/v24.0/${PHONE_NUMBER_ID}/messages`);
  });

  it('o phone_number_id vai codificado no caminho (nunca injeta segmentos)', async () => {
    const client = makeClient();
    await client.sendText({ ...input, phoneNumberId: '1/../x?y=1' });
    assert.equal(graph.requests[0]?.path, '/v26.0/1%2F..%2Fx%3Fy%3D1/messages');
  });

  it('registra métrica de envio ok e error, sem dado do contato', async () => {
    const metrics = createMetrics();
    const client = makeClient({ metrics });
    assert.ok((await client.sendText(input)).ok);
    graph.failNext(1, graphError(401, 190));
    assert.equal((await client.sendText(input)).ok, false);
    const body = await metrics.render();
    assert.match(body, /channel_send_total{channel="whatsapp",result="ok"} 1/);
    assert.match(body, /channel_send_total{channel="whatsapp",result="error"} 1/);
    assert.match(body, /channel_send_duration_seconds_count{channel="whatsapp"} 2/);
    assert.ok(!body.includes(CONTACT));
    assert.ok(!body.includes(PHONE_NUMBER_ID));
  });

  it('métrica que lança não derruba o envio', async () => {
    const client = makeClient({
      metrics: {
        observeChannelSend() {
          throw new Error('métrica quebrada');
        },
      },
    });
    assert.ok((await client.sendText(input)).ok);
  });
});

describe('WhatsappCloudApiClient: classificação dos erros', () => {
  it('HTTP 500, 503 (HTML), 429 e 408 são retentáveis', async () => {
    for (const [status, body] of [
      [500, { error: { code: 1, type: 'OAuthException' } }],
      [503, undefined],
      [429, undefined],
      [408, undefined],
    ] as const) {
      graph.failNext(1, { kind: 'respond', status, body });
      const error = await expectFailure(makeClient());
      assert.equal(error.retryable, true, `HTTP ${String(status)}`);
      assert.equal(error.httpStatus, status);
      assert.equal(error.reason, 'http_error');
    }
  });

  it('códigos de limite de taxa da Meta são retentáveis mesmo com status 4xx', async () => {
    for (const code of [4, 80007, 130429, 131056, 17, 32, 613, 2, 131016, 133004, 131000]) {
      graph.failNext(1, graphError(400, code));
      const error = await expectFailure(makeClient());
      assert.equal(error.retryable, true, `código ${String(code)}`);
      assert.equal(error.providerCode, code);
      assert.equal(error.providerType, 'OAuthException');
    }
  });

  it('token inválido/expirado, janela de 24 h, destinatário inválido e parâmetro inválido são permanentes', async () => {
    for (const [status, code] of [
      [401, 190],
      [401, 0],
      [400, 190],
      [400, 131047],
      [400, 131026],
      [400, 131030],
      [400, 131021],
      [400, 131008],
      [400, 131009],
      [400, 100],
      [403, 10],
      [400, 131042],
      [400, 368],
    ] as const) {
      graph.failNext(1, graphError(status, code));
      const error = await expectFailure(makeClient());
      assert.equal(error.retryable, false, `HTTP ${String(status)} código ${String(code)}`);
      assert.equal(error.httpStatus, status);
      assert.equal(error.providerCode, code);
    }
  });

  it('4xx sem corpo JSON utilizável é permanente; 3xx não é seguido (permanente)', async () => {
    graph.failNext(1, { kind: 'respond', status: 404 });
    assert.equal((await expectFailure(makeClient())).retryable, false);
    graph.failNext(1, { kind: 'respond', status: 302, body: { location: 'x' } });
    const redirected = await expectFailure(makeClient());
    assert.equal(redirected.retryable, false);
    assert.equal(redirected.httpStatus, 302);
  });

  it('2xx sem wamid (corpo inesperado) é permanente: a Meta pode ter enviado, então nada de reenviar', async () => {
    for (const body of [{}, { messages: [] }, { messages: [{ id: '' }] }, undefined]) {
      graph.failNext(1, { kind: 'respond', status: 200, body });
      const error = await expectFailure(makeClient());
      assert.equal(error.reason, 'invalid_response');
      assert.equal(error.retryable, false);
    }
  });

  it('timeout (servidor que não responde) e queda de conexão são retentáveis', async () => {
    const release = keepEventLoopAlive();
    try {
      graph.failNext(1, { kind: 'hang' });
      const timedOut = await expectFailure(makeClient({ timeoutMs: 150 }));
      assert.equal(timedOut.reason, 'timeout');
      assert.equal(timedOut.retryable, true);

      graph.failNext(1, { kind: 'drop' });
      const dropped = await expectFailure(makeClient());
      assert.equal(dropped.reason, 'network');
      assert.equal(dropped.retryable, true);
    } finally {
      release();
    }
  });

  it('servidor inalcançável é erro de rede retentável', async () => {
    const error = await expectFailure(makeClient({ baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(error.reason, 'network');
    assert.equal(error.retryable, true);
  });

  it('isRetryableGraphFailure: o código conhecido vence o status', () => {
    assert.equal(isRetryableGraphFailure(400, 130429), true);
    assert.equal(isRetryableGraphFailure(500, 190), true);
    assert.equal(isRetryableGraphFailure(400, undefined), false);
    assert.equal(isRetryableGraphFailure(200, undefined), false);
  });
});

describe('WhatsappCloudApiClient: privacidade do erro', () => {
  it('o erro leva só status, code, type e retentável: nunca token, texto, destinatário nem a mensagem da Meta', async () => {
    graph.failNext(1, graphError(400, 131047));
    const error = await expectFailure(makeClient());
    assert.deepEqual(error.context, {
      reason: 'http_error',
      retryable: false,
      httpStatus: 400,
      providerCode: 131047,
      providerType: 'OAuthException',
    });
    const everything = JSON.stringify({
      message: error.message,
      context: error.context,
      stack: error.stack,
      cause: error.cause,
      own: Object.entries(error),
    });
    for (const secret of [TOKEN, SECRET_TEXT, CONTACT, PHONE_NUMBER_ID, 'texto da Meta']) {
      assert.ok(!everything.includes(secret), `vazou: ${secret}`);
    }
  });

  it('falhas de rede e de timeout também não carregam o token nem o destinatário', async () => {
    const release = keepEventLoopAlive();
    try {
      graph.failNext(1, { kind: 'hang' });
      const error = await expectFailure(makeClient({ timeoutMs: 100 }));
      const everything = JSON.stringify({ m: error.message, c: error.context, s: error.stack });
      for (const secret of [TOKEN, SECRET_TEXT, CONTACT]) {
        assert.ok(!everything.includes(secret), `vazou: ${secret}`);
      }
      assert.equal(error.cause, undefined);
    } finally {
      release();
    }
  });
});
