import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type {
  InboundChannelMessage,
  IntakeSummary,
} from '../../application/channel/channel-intake.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { Result } from '../../shared/types/index.js';
import {
  fakeWamid,
  signWebhookBody,
  webhookPayload,
} from '../../test-support/whatsapp-payloads.js';
import { WEBHOOK_BODY_LIMIT_BYTES, WHATSAPP_WEBHOOK_ROUTE } from './whatsapp-webhook.controller.js';

const APP_SECRET = `app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `verify-token-${randomUUID()}`;
const SECRET_TEXT = 'texto-secreto-do-webhook-7b9';
const CONTACT = '5511987654321';
const PROFILE_NAME = 'Nome Secreto de Perfil';
const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

class FakeIntake {
  readonly calls: { messages: readonly InboundChannelMessage[]; requestId: string }[] = [];
  summary: (messages: readonly InboundChannelMessage[]) => IntakeSummary = (messages) => ({
    enqueued: messages.length,
    discarded: 0,
    failed: 0,
  });

  accept(messages: readonly InboundChannelMessage[], requestId: string): Promise<IntakeSummary> {
    this.calls.push({ messages, requestId });
    return Promise.resolve(this.summary(messages));
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly intake: FakeIntake;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly metrics: ReturnType<typeof createMetrics>;
}

async function start(enabled = true): Promise<Harness> {
  const intake = new FakeIntake();
  const logs = captureLogs();
  const metrics = createMetrics();
  const app = buildServer({
    logger: logs.logger,
    readiness: ALL_UP,
    metrics,
    ...(enabled ? { whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, intake } } : {}),
  });
  // Uma rota comum na raiz, para provar que o parser cru fica restrito ao plugin do webhook.
  void app.register((instance, _options, done) => {
    instance.post('/test/json', (request) => ({ type: typeof request.body, body: request.body }));
    done();
  });
  await app.ready();
  return { app, intake, logs, metrics };
}

async function withServer(fn: (h: Harness) => Promise<void>, enabled = true): Promise<void> {
  const h = await start(enabled);
  try {
    await fn(h);
  } finally {
    await h.app.close();
  }
}

async function post(
  h: Harness,
  body: string | Buffer,
  headers: Record<string, string> = {},
  signed = true,
) {
  return h.app.inject({
    method: 'POST',
    url: WHATSAPP_WEBHOOK_ROUTE,
    headers: {
      'content-type': 'application/json',
      ...(signed ? { 'x-hub-signature-256': signWebhookBody(body, APP_SECRET) } : {}),
      ...headers,
    },
    payload: body,
  });
}

const textPayload = (
  phoneNumberId = '106540352242922',
  text = SECRET_TEXT,
  from = CONTACT,
): string =>
  JSON.stringify(
    webhookPayload([
      {
        phoneNumberId,
        profileName: PROFILE_NAME,
        messages: [{ id: fakeWamid(from), from, text }],
      },
    ]),
  );

async function metricLine(h: Harness, name: string, labels: string): Promise<number> {
  const body = await h.metrics.render();
  const match = new RegExp(`${name}\\{${labels}\\} (\\d+)`).exec(body);
  return match === null ? 0 : Number(match[1]);
}

const verifyUrl = (query: Record<string, string>): string =>
  `${WHATSAPP_WEBHOOK_ROUTE}?${new URLSearchParams(query).toString()}`;

describe('GET /webhooks/whatsapp (verificação)', () => {
  it('com hub.mode=subscribe e o token certo devolve 200 text/plain só com o challenge', async () => {
    await withServer(async (h) => {
      const response = await h.app.inject({
        method: 'GET',
        url: verifyUrl({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        }),
      });
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /^text\/plain/);
      assert.equal(response.body, '1158201444');
      assert.equal(
        await metricLine(
          h,
          'webhook_requests_total',
          'channel="whatsapp",result="verification_ok"',
        ),
        1,
      );
    });
  });

  it('token errado, ausente, modo diferente ou challenge ausente/inválido: 403, sem eco do challenge', async () => {
    await withServer(async (h) => {
      const cases: Record<string, string>[] = [
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'zzchallenge1' },
        { 'hub.mode': 'subscribe', 'hub.challenge': 'zzchallenge1' },
        {
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'zzchallenge1',
        },
        { 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'zzchallenge1' },
        { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN },
        { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '<script>' },
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN.slice(0, -1),
          'hub.challenge': 'zzchallenge1',
        },
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': `${VERIFY_TOKEN}x`,
          'hub.challenge': 'zzchallenge1',
        },
        {},
      ];
      for (const query of cases) {
        const response = await h.app.inject({ method: 'GET', url: verifyUrl(query) });
        assert.equal(response.statusCode, 403, JSON.stringify(query));
        assert.ok(!response.body.includes('zzchallenge1'), 'não ecoa o challenge');
        assert.match(String(response.headers['content-type']), /^application\/json/);
      }
      // Parâmetro repetido também é recusado.
      const repeated = await h.app.inject({
        method: 'GET',
        url: `${WHATSAPP_WEBHOOK_ROUTE}?hub.mode=subscribe&hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
      });
      assert.equal(repeated.statusCode, 403);
      assert.equal(
        await metricLine(
          h,
          'webhook_requests_total',
          'channel="whatsapp",result="verification_failed"',
        ),
        cases.length + 1,
      );
    });
  });

  it('nenhum log contém a query string, o verify token nem o segredo do app (sucesso e recusa)', async () => {
    await withServer(async (h) => {
      await h.app.inject({
        method: 'GET',
        url: verifyUrl({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'zzchallenge2',
        }),
      });
      await h.app.inject({
        method: 'GET',
        url: verifyUrl({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'errado-9981',
          'hub.challenge': 'zzchallenge3',
        }),
      });
      const raw = h.logs.raw();
      assert.ok(raw.length > 0);
      for (const secret of [
        VERIFY_TOKEN,
        APP_SECRET,
        'errado-9981',
        'hub.verify_token',
        'hub.challenge',
        'zzchallenge2',
        'zzchallenge3',
      ]) {
        assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
      }
    });
  });
});

describe('POST /webhooks/whatsapp (assinatura e corpo cru)', () => {
  it('assinatura válida é aceita (200) e entrega ao intake as mensagens mapeadas', async () => {
    await withServer(async (h) => {
      const response = await post(h, textPayload('106540352242922'));
      assert.equal(response.statusCode, 200);
      assert.equal(h.intake.calls.length, 1);
      const call = h.intake.calls[0];
      assert.deepEqual(call?.messages, [
        {
          phoneNumberId: '106540352242922',
          messageId: fakeWamid(CONTACT),
          sender: CONTACT,
          content: { kind: 'text', text: SECRET_TEXT },
        },
      ]);
      assert.equal(call.requestId.length > 0, true);
      assert.equal(
        await metricLine(h, 'webhook_requests_total', 'channel="whatsapp",result="ok"'),
        1,
      );
    });
  });

  it('o x-request-id válido do webhook acompanha o intake (correlação com o worker)', async () => {
    await withServer(async (h) => {
      await post(h, textPayload(), { 'x-request-id': 'req-correlacao-123' });
      assert.equal(h.intake.calls[0]?.requestId, 'req-correlacao-123');
    });
  });

  it('assinatura ausente, malformada, de tamanho errado ou com outro segredo: 401 e nada é processado', async () => {
    await withServer(async (h) => {
      const body = textPayload();
      const good = signWebhookBody(body, APP_SECRET);
      const attempts: (string | undefined)[] = [
        undefined,
        '',
        'sha256=',
        good.slice(0, -2),
        `${good}ab`,
        good.replace('sha256=', 'sha1='),
        signWebhookBody(body, 'outro-segredo'),
        signWebhookBody('{}', APP_SECRET),
      ];
      for (const signature of attempts) {
        const response = await post(
          h,
          body,
          signature === undefined ? {} : { 'x-hub-signature-256': signature },
          false,
        );
        assert.equal(response.statusCode, 401, String(signature));
        assert.equal(response.json<{ error: { code: string } }>().error.code, 'UNAUTHORIZED');
      }
      assert.equal(h.intake.calls.length, 0);
      assert.equal(
        await metricLine(
          h,
          'webhook_requests_total',
          'channel="whatsapp",result="invalid_signature"',
        ),
        attempts.length,
      );
    });
  });

  it('a assinatura é conferida sobre os bytes crus: o mesmo JSON com espaços diferentes é recusado', async () => {
    await withServer(async (h) => {
      const original = textPayload();
      const reformatted = JSON.stringify(JSON.parse(original), null, 2);
      const response = await post(
        h,
        reformatted,
        {
          'x-hub-signature-256': signWebhookBody(original, APP_SECRET),
        },
        false,
      );
      assert.equal(response.statusCode, 401);
      assert.equal(h.intake.calls.length, 0);
      // E o corpo reformatado, assinado por ele mesmo, passa.
      assert.equal((await post(h, reformatted)).statusCode, 200);
    });
  });

  it('o corpo só é interpretado depois da assinatura: corpo malformado sem assinatura é 401, não 400', async () => {
    await withServer(async (h) => {
      const response = await post(h, '{isto não é json', {}, false);
      assert.equal(response.statusCode, 401);
      assert.equal(h.intake.calls.length, 0);
    });
  });

  it('corpo acima de 3 MiB é recusado, mesmo assinado, e nada é processado', async () => {
    await withServer(async (h) => {
      const huge = JSON.stringify({ padding: 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES + 10) });
      const response = await post(h, huge);
      assert.equal(response.statusCode, 413);
      assert.equal(h.intake.calls.length, 0);
    });
  });

  it('corpo logo abaixo de 3 MiB, assinado, é aceito', async () => {
    await withServer(async (h) => {
      const near = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [],
        padding: 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES - 200),
      });
      assert.ok(WEBHOOK_BODY_LIMIT_BYTES >= 3_000_000, 'cobre os 3 MB da Meta');
      assert.ok(Buffer.byteLength(near) < WEBHOOK_BODY_LIMIT_BYTES);
      assert.ok(Buffer.byteLength(near) > 2_000_000, 'bem acima do antigo limite de 1 MiB');
      assert.equal((await post(h, near)).statusCode, 200);
    });
  });

  it('content-type que não é JSON nunca passa pela assinatura (401, nada processado), e o parser cru fica restrito ao plugin do webhook', async () => {
    await withServer(async (h) => {
      const text = await h.app.inject({
        method: 'POST',
        url: WHATSAPP_WEBHOOK_ROUTE,
        headers: {
          'content-type': 'text/plain',
          'x-hub-signature-256': signWebhookBody('x', APP_SECRET),
        },
        payload: 'x',
      });
      assert.equal(text.statusCode, 401);
      assert.equal(h.intake.calls.length, 0);
      // Em outra rota o JSON continua sendo interpretado como objeto (parser padrão).
      const other = await h.app.inject({
        method: 'POST',
        url: '/test/json',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ a: 1 }),
      });
      assert.deepEqual(other.json(), { type: 'object', body: { a: 1 } });
    });
  });

  it('com o canal desligado (sem o parâmetro whatsapp) as duas rotas respondem 404', async () => {
    await withServer(async (h) => {
      const get = await h.app.inject({
        method: 'GET',
        url: verifyUrl({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1',
        }),
      });
      assert.equal(get.statusCode, 404);
      const response = await post(h, textPayload());
      assert.equal(response.statusCode, 404);
      assert.equal(h.intake.calls.length, 0);
    }, false);
  });
});

describe('POST /webhooks/whatsapp (conteúdo)', () => {
  it('lote com vários números e mensagens: tudo vai ao intake, na ordem, com o número do negócio de cada uma', async () => {
    await withServer(async (h) => {
      const body = JSON.stringify(
        webhookPayload([
          {
            phoneNumberId: '1001',
            messages: [
              { id: 'wamid.1', from: '5511111111111', text: 'um' },
              { id: 'wamid.2', from: '5511222222222', type: 'image' },
            ],
          },
          {
            phoneNumberId: '1002',
            messages: [{ id: 'wamid.3', from: '5511333333333', text: 'três' }],
          },
        ]),
      );
      assert.equal((await post(h, body)).statusCode, 200);
      assert.deepEqual(h.intake.calls[0]?.messages, [
        {
          phoneNumberId: '1001',
          messageId: 'wamid.1',
          sender: '5511111111111',
          content: { kind: 'text', text: 'um' },
        },
        {
          phoneNumberId: '1001',
          messageId: 'wamid.2',
          sender: '5511222222222',
          content: { kind: 'unsupported' },
        },
        {
          phoneNumberId: '1002',
          messageId: 'wamid.3',
          sender: '5511333333333',
          content: { kind: 'text', text: 'três' },
        },
      ]);
    });
  });

  it('mensagem sem "from" (só id de usuário do negócio) chega ao intake com remetente ausente', async () => {
    await withServer(async (h) => {
      const body = JSON.stringify(
        webhookPayload([
          {
            phoneNumberId: '1001',
            messages: [
              { id: 'wamid.1', text: 'oi', extra: { from_user_id: 'US.13491208655302741918' } },
            ],
          },
        ]),
      );
      assert.equal((await post(h, body)).statusCode, 200);
      assert.equal(h.intake.calls[0]?.messages[0]?.sender, undefined);
    });
  });

  it('o companyId nunca vem de fora: cabeçalho, query e corpo com companyId são ignorados', async () => {
    await withServer(async (h) => {
      const payload = webhookPayload([
        {
          phoneNumberId: '1001',
          messages: [
            {
              id: 'wamid.1',
              from: CONTACT,
              text: 'oi',
              extra: { companyId: randomUUID(), company_id: randomUUID() },
            },
          ],
        },
      ]);
      const body = JSON.stringify({ ...payload, companyId: randomUUID() });
      const response = await h.app.inject({
        method: 'POST',
        url: `${WHATSAPP_WEBHOOK_ROUTE}?companyId=${randomUUID()}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signWebhookBody(body, APP_SECRET),
          'x-company-id': randomUUID(),
        },
        payload: body,
      });
      assert.equal(response.statusCode, 200);
      const [message] = h.intake.calls[0]?.messages ?? [];
      assert.deepEqual(Object.keys(message ?? {}).sort(), [
        'content',
        'messageId',
        'phoneNumberId',
        'sender',
      ]);
    });
  });

  it('statuses não geram job: só métrica; failed loga warn com a referência e o código, sem telefone nem mensagem da Meta', async () => {
    await withServer(async (h) => {
      const wamid = fakeWamid(CONTACT, '-saida');
      const body = JSON.stringify(
        webhookPayload([
          {
            phoneNumberId: '1001',
            statuses: [
              { id: wamid, status: 'delivered', recipientId: CONTACT },
              { id: wamid, status: 'read', recipientId: CONTACT },
              { id: wamid, status: 'failed', recipientId: CONTACT, errorCode: 131049 },
              { id: wamid, status: 'algo-novo', recipientId: CONTACT },
            ],
          },
        ]),
      );
      const response = await post(h, body);
      assert.equal(response.statusCode, 200);
      assert.equal(h.intake.calls.length, 0, 'nenhum job, nenhuma resposta');
      for (const status of ['delivered', 'read', 'failed', 'other']) {
        assert.equal(
          await metricLine(
            h,
            'channel_status_events_total',
            `channel="whatsapp",status="${status}"`,
          ),
          1,
          status,
        );
      }
      const warn = h.logs
        .lines()
        .find((line) => line.msg === 'o canal informou falha na entrega de uma mensagem');
      assert.equal(warn?.level, 40);
      assert.equal(warn.errorCode, 131049);
      assert.equal(typeof warn.messageRef, 'string');
      const raw = h.logs.raw();
      for (const secret of [CONTACT, wamid, 'mensagem da Meta', 'detalhe da Meta']) {
        assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
      }
    });
  });

  it('assinatura válida com JSON inválido ou formato inesperado: 200 + invalid_payload, nada enfileirado', async () => {
    await withServer(async (h) => {
      const invalid = [
        '{isto não é json',
        '',
        '[]',
        '"texto"',
        'null',
        '{"entry":"x"}',
        '{"object":"whatsapp_business_account","entry":[{"changes":"x"}]}',
        '{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"metadata":{}}}]}]}',
        '{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"abc"}}}]}]}',
      ];
      for (const body of invalid) {
        const response = await post(h, body);
        assert.equal(response.statusCode, 200, body);
      }
      assert.equal(h.intake.calls.length, 0);
      assert.equal(
        await metricLine(
          h,
          'webhook_requests_total',
          'channel="whatsapp",result="invalid_payload"',
        ),
        invalid.length,
      );
      assert.ok(h.logs.lines().some((line) => line.level === 40));
    });
  });

  it('parte inválida do corpo não impede o aproveitamento do resto', async () => {
    await withServer(async (h) => {
      const payload = webhookPayload([
        { phoneNumberId: '1001', messages: [{ id: 'wamid.ok', from: CONTACT, text: 'oi' }] },
      ]);
      const entry = (payload.entry as { changes: unknown[] }[])[0];
      entry?.changes.push({ field: 'messages', value: { metadata: {} } });
      const body = JSON.stringify(payload);
      assert.equal((await post(h, body)).statusCode, 200);
      assert.equal(h.intake.calls[0]?.messages.length, 1);
      assert.equal(
        await metricLine(
          h,
          'webhook_requests_total',
          'channel="whatsapp",result="invalid_payload"',
        ),
        1,
      );
    });
  });

  it('outros campos assinados e outro objeto da Meta são ignorados sem erro', async () => {
    await withServer(async (h) => {
      const template = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          { changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED' } }] },
        ],
      });
      assert.equal((await post(h, template)).statusCode, 200);
      const other = JSON.stringify({
        object: 'instagram',
        entry: [{ changes: [{ field: 'comments', value: {} }] }],
      });
      assert.equal((await post(h, other)).statusCode, 200);
      assert.equal(h.intake.calls.length, 0);
      assert.equal(
        await metricLine(h, 'webhook_requests_total', 'channel="whatsapp",result="ok"'),
        2,
      );
    });
  });

  it('falha ao enfileirar (fila ou banco fora) responde 500 para a Meta retentar; a reentrega passa', async () => {
    await withServer(async (h) => {
      h.intake.summary = (messages) => ({ enqueued: messages.length - 1, discarded: 0, failed: 1 });
      const body = JSON.stringify(
        webhookPayload([
          {
            phoneNumberId: '1001',
            messages: [
              { id: 'wamid.1', from: CONTACT, text: 'um' },
              { id: 'wamid.2', from: CONTACT, text: 'dois' },
            ],
          },
        ]),
      );
      const response = await post(h, body);
      assert.equal(response.statusCode, 500);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'ENQUEUE_FAILED');
      assert.equal(
        await metricLine(h, 'webhook_requests_total', 'channel="whatsapp",result="enqueue_failed"'),
        1,
      );

      h.intake.summary = (messages) => ({ enqueued: messages.length, discarded: 0, failed: 0 });
      assert.equal((await post(h, body)).statusCode, 200);
      assert.equal(h.intake.calls.length, 2, 'o lote inteiro é reapresentado ao intake');
    });
  });
});

describe('POST /webhooks/whatsapp (privacidade nos logs)', () => {
  it('texto, remetente, nome de perfil, wamid, segredos e a assinatura não aparecem em nenhum log', async () => {
    await withServer(async (h) => {
      const body = textPayload('1001');
      const signature = signWebhookBody(body, APP_SECRET);
      await post(h, body);
      await post(h, body, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, false);
      await post(h, '{não é json');
      await post(h, '{"entry":"x"}');
      h.intake.summary = () => ({ enqueued: 0, discarded: 0, failed: 1 });
      await post(h, body);

      const raw = h.logs.raw();
      assert.ok(raw.length > 0);
      for (const secret of [
        SECRET_TEXT,
        CONTACT,
        PROFILE_NAME,
        fakeWamid(CONTACT),
        Buffer.from(`\u001c\u0018\u000b${CONTACT}`).toString('base64'),
        APP_SECRET,
        VERIFY_TOKEN,
        signature,
      ]) {
        assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
      }
    });
  });
});

describe('POST /webhooks/whatsapp (tipos de mensagem)', () => {
  it('áudio e imagem viram conteúdo não suportado (aviso); reação, system e tipo desconhecido, ignorado', async () => {
    await withServer(async (h) => {
      const body = JSON.stringify(
        webhookPayload([
          {
            phoneNumberId: '1001',
            messages: [
              { id: 'wamid.a', from: CONTACT, type: 'audio' },
              { id: 'wamid.i', from: CONTACT, type: 'image' },
              {
                id: 'wamid.r',
                from: CONTACT,
                type: 'reaction',
                extra: { reaction: { emoji: 'x' } },
              },
              { id: 'wamid.s', type: 'system', extra: { system: { body: 'mudou' } } },
              { id: 'wamid.n', from: CONTACT, type: 'tipo_novo' },
              { id: 'wamid.t', from: CONTACT, text: 'oi' },
            ],
          },
        ]),
      );
      assert.equal((await post(h, body)).statusCode, 200);
      assert.deepEqual(
        h.intake.calls[0]?.messages.map((message) => [message.messageId, message.content.kind]),
        [
          ['wamid.a', 'unsupported'],
          ['wamid.i', 'unsupported'],
          ['wamid.r', 'ignored'],
          ['wamid.s', 'ignored'],
          ['wamid.n', 'ignored'],
          ['wamid.t', 'text'],
        ],
      );
    });
  });
});
