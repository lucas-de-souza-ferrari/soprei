import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type {
  InboundChannelEcho,
  InboundChannelMessage,
  IntakeSummary,
} from '../../application/channel/channel-intake.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { Result } from '../../shared/types/index.js';
import {
  echoWebhookPayload,
  fakeWamid,
  signWebhookBody,
  webhookPayload,
} from '../../test-support/whatsapp-payloads.js';
import { WHATSAPP_WEBHOOK_ROUTE } from './whatsapp-webhook.controller.js';
import { parseWebhookBody } from './whatsapp-webhook.schemas.js';

const APP_SECRET = `app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `verify-token-${randomUUID()}`;
const NUMBER = '106540352242922';
const CONTACT = '5511987654321';
const SECRET_TEXT = 'texto-secreto-da-equipe-eco-039';
const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

class FakeIntake {
  readonly messages: InboundChannelMessage[][] = [];
  readonly echoes: InboundChannelEcho[][] = [];
  echoSummary: (echoes: readonly InboundChannelEcho[]) => IntakeSummary = (echoes) => ({
    enqueued: echoes.length,
    discarded: 0,
    failed: 0,
  });

  accept(messages: readonly InboundChannelMessage[]): Promise<IntakeSummary> {
    this.messages.push([...messages]);
    return Promise.resolve({ enqueued: messages.length, discarded: 0, failed: 0 });
  }

  acceptEchoes(echoes: readonly InboundChannelEcho[]): Promise<IntakeSummary> {
    this.echoes.push([...echoes]);
    return Promise.resolve(this.echoSummary(echoes));
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly intake: FakeIntake;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly metrics: ReturnType<typeof createMetrics>;
}

async function withServer(
  echoesEnabled: boolean,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const intake = new FakeIntake();
  const logs = captureLogs();
  const metrics = createMetrics();
  const app = buildServer({
    logger: logs.logger,
    readiness: ALL_UP,
    metrics,
    whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, intake, echoesEnabled },
  });
  await app.ready();
  try {
    await fn({ app, intake, logs, metrics });
  } finally {
    await app.close();
  }
}

function post(h: Harness, body: string, signed = true) {
  return h.app.inject({
    method: 'POST',
    url: WHATSAPP_WEBHOOK_ROUTE,
    headers: {
      'content-type': 'application/json',
      ...(signed ? { 'x-hub-signature-256': signWebhookBody(body, APP_SECRET) } : {}),
    },
    payload: body,
  });
}

async function metricLine(h: Harness, name: string, labels: string): Promise<number> {
  const body = await h.metrics.render();
  const match = new RegExp(`${name}\\{${labels}\\} (\\d+)`).exec(body);
  return match === null ? 0 : Number(match[1]);
}

const echoBody = (echoes = [{ id: fakeWamid(CONTACT, 'ECO'), to: CONTACT, text: SECRET_TEXT }]) =>
  JSON.stringify(echoWebhookPayload(NUMBER, echoes));

describe('parseWebhookBody: eco da coexistência (spec 039, formato do E0)', () => {
  it('lê o eco de value.message_echoes[]: o contato é o "to"; texto e mídia', () => {
    const parsed = parseWebhookBody(
      echoWebhookPayload(NUMBER, [
        { id: 'wamid.eco.1', to: CONTACT, text: 'olá' },
        { id: 'wamid.eco.2', to: CONTACT, type: 'image' },
      ]),
    );
    assert.equal(parsed.invalid, false);
    assert.equal(parsed.messages.length, 0, 'eco nunca vira mensagem do contato');
    assert.deepEqual(parsed.echoes, [
      {
        phoneNumberId: NUMBER,
        messageId: 'wamid.eco.1',
        recipient: CONTACT,
        content: { kind: 'text', text: 'olá' },
      },
      {
        phoneNumberId: NUMBER,
        messageId: 'wamid.eco.2',
        recipient: CONTACT,
        content: { kind: 'media' },
      },
    ]);
  });

  it('history e smb_app_state_sync são contados como ignorados e não geram nada (D6)', () => {
    for (const field of ['history', 'smb_app_state_sync']) {
      const parsed = parseWebhookBody(
        echoWebhookPayload(NUMBER, [{ id: 'wamid.x', to: CONTACT, text: 'x' }], field),
      );
      assert.equal(parsed.ignoredChanges, 1, field);
      assert.equal(parsed.echoes.length, 0, field);
      assert.equal(parsed.messages.length, 0, field);
    }
  });

  it('eco fora do formato marca invalid; o resto do lote é aproveitado', () => {
    const payload = echoWebhookPayload(NUMBER, [{ id: 'wamid.ok', to: CONTACT, text: 'ok' }]);
    const entry = (
      payload['entry'] as { changes: { value: { message_echoes: unknown[] } }[] }[]
    )[0];
    entry?.changes[0]?.value.message_echoes.push({ to: CONTACT });
    const parsed = parseWebhookBody(payload);
    assert.equal(parsed.invalid, true);
    assert.equal(parsed.echoes.length, 1);
    const noMetadata = parseWebhookBody({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [] } }] }],
    });
    assert.equal(noMetadata.invalid, true);
  });
});

describe('POST /webhooks/whatsapp com eco (spec 039)', () => {
  it('com a coexistência ligada: eco vai ao intake, carimbado; 200 e sem texto em log', async () => {
    await withServer(true, async (h) => {
      const response = await post(h, echoBody());
      assert.equal(response.statusCode, 200);
      assert.equal(h.intake.echoes.length, 1);
      const [echo] = h.intake.echoes[0] ?? [];
      assert.ok(echo);
      assert.equal(echo.recipient, CONTACT);
      assert.ok(echo.receivedAt instanceof Date);
      const raw = h.logs.raw();
      for (const secret of [SECRET_TEXT, CONTACT, fakeWamid(CONTACT, 'ECO')]) {
        assert.equal(logContains(raw, secret), false, secret);
      }
    });
  });

  it('assinatura inválida: 401 e nada é processado', async () => {
    await withServer(true, async (h) => {
      const response = await post(h, echoBody(), false);
      assert.equal(response.statusCode, 401);
      assert.equal(h.intake.echoes.length, 0);
    });
  });

  it('assinatura válida e corpo inválido: 200 + invalid_payload', async () => {
    await withServer(true, async (h) => {
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'smb_message_echoes', value: { nada: true } }] }],
      });
      const response = await post(h, body);
      assert.equal(response.statusCode, 200);
      assert.equal(h.intake.echoes.length, 0);
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

  it('sem a coexistência: eco não é tratado (disabled) e nada vai ao intake', async () => {
    await withServer(false, async (h) => {
      const response = await post(h, echoBody());
      assert.equal(response.statusCode, 200);
      assert.equal(h.intake.echoes.length, 0);
      assert.equal(await metricLine(h, 'channel_echo_events_total', 'result="disabled"'), 1);
    });
  });

  it('history não gera job nem gravação (ignored_type)', async () => {
    await withServer(true, async (h) => {
      const body = JSON.stringify(
        echoWebhookPayload(NUMBER, [{ id: 'wamid.h', to: CONTACT, text: SECRET_TEXT }], 'history'),
      );
      const response = await post(h, body);
      assert.equal(response.statusCode, 200);
      assert.equal(h.intake.echoes.length, 0);
      assert.equal(h.intake.messages.length, 0);
      assert.equal(
        await metricLine(
          h,
          'channel_inbound_messages_total',
          'channel="whatsapp",result="ignored_type"',
        ),
        1,
      );
    });
  });

  it('falha ao enfileirar o eco: 500 (a Meta reentrega)', async () => {
    await withServer(true, async (h) => {
      h.intake.echoSummary = (echoes) => ({ enqueued: 0, discarded: 0, failed: echoes.length });
      const response = await post(h, echoBody());
      assert.equal(response.statusCode, 500);
    });
  });

  it('status repetido (delivered duas vezes, visto no E0) só conta métrica: nada é gravado', async () => {
    await withServer(true, async (h) => {
      const body = JSON.stringify(
        webhookPayload([
          {
            phoneNumberId: NUMBER,
            statuses: [
              { id: 'wamid.saida.1', status: 'delivered', recipientId: CONTACT },
              { id: 'wamid.saida.1', status: 'delivered', recipientId: CONTACT },
            ],
          },
        ]),
      );
      for (let i = 0; i < 2; i += 1) {
        const response = await post(h, body);
        assert.equal(response.statusCode, 200);
      }
      assert.equal(h.intake.messages.length, 0);
      assert.equal(h.intake.echoes.length, 0);
      assert.equal(
        await metricLine(h, 'channel_status_events_total', 'channel="whatsapp",status="delivered"'),
        4,
      );
    });
  });
});
