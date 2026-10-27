import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Counter } from 'prom-client';
import { createMetrics } from './metrics.js';

describe('createMetrics', () => {
  it('cada chamada tem o seu registry (nada de estado global compartilhado)', async () => {
    const a = createMetrics();
    const b = createMetrics();
    a.observeHttpRequest({ method: 'GET', route: '/x', statusCode: 200, durationSeconds: 0.01 });
    assert.match(await a.render(), /http_requests_total\{method="GET",route="\/x"/);
    assert.doesNotMatch(await b.render(), /route="\/x"/);
    assert.notEqual(a.registry, b.registry);
  });

  it('inclui as métricas padrão do processo e HTTP com buckets explícitos de 5 ms a 10 s', async () => {
    const metrics = createMetrics();
    metrics.observeHttpRequest({
      method: 'GET',
      route: '/x',
      statusCode: 404,
      durationSeconds: 0.2,
    });
    const body = await metrics.render();
    assert.match(body, /process_cpu_user_seconds_total/);
    assert.match(body, /nodejs_heap_size_total_bytes/);
    assert.match(body, /http_requests_total\{method="GET",route="\/x",status_class="4xx"\} 1/);
    for (const le of [
      '0.005',
      '0.01',
      '0.025',
      '0.05',
      '0.1',
      '0.25',
      '0.5',
      '1',
      '2.5',
      '5',
      '10',
    ]) {
      assert.match(body, new RegExp(`http_request_duration_seconds_bucket\\{le="${le}"`), le);
    }
    assert.match(
      body,
      /http_request_duration_seconds_count\{method="GET",route="\/x",status_class="4xx"\} 1/,
    );
  });

  it('db_query_duration_seconds é por model e operation', async () => {
    const metrics = createMetrics();
    metrics.observeDbQuery({ model: 'Client', operation: 'create', durationSeconds: 0.003 });
    metrics.observeDbQuery({ model: 'Client', operation: 'create', durationSeconds: 0.004 });
    metrics.observeDbQuery({ model: 'Conversation', operation: 'findMany', durationSeconds: 0.5 });
    const body = await metrics.render();
    assert.match(body, /db_query_duration_seconds_count\{model="Client",operation="create"\} 2/);
    assert.match(
      body,
      /db_query_duration_seconds_count\{model="Conversation",operation="findMany"\} 1/,
    );
  });

  it('o gauge do pool é lido no momento da coleta, sem timers, e acompanha a fonte', async () => {
    const metrics = createMetrics();
    assert.doesNotMatch(await metrics.render(), /db_pool_connections\{/);

    let snapshot = { totalCount: 3, idleCount: 2, waitingCount: 1 };
    let reads = 0;
    metrics.bindPool(() => {
      reads += 1;
      return snapshot;
    });
    assert.equal(reads, 0, 'bindPool não lê nada por si só');

    let body = await metrics.render();
    assert.equal(reads, 1);
    assert.match(body, /db_pool_connections\{state="total"\} 3/);
    assert.match(body, /db_pool_connections\{state="idle"\} 2/);
    assert.match(body, /db_pool_connections\{state="waiting"\} 1/);

    snapshot = { totalCount: 5, idleCount: 0, waitingCount: 4 };
    body = await metrics.render();
    assert.equal(reads, 2);
    assert.match(body, /db_pool_connections\{state="total"\} 5/);
    assert.match(body, /db_pool_connections\{state="waiting"\} 4/);
  });

  it('as próximas specs podem registrar as suas métricas no mesmo registry', async () => {
    const metrics = createMetrics();
    const custom = new Counter({
      name: 'custom_events_total',
      help: 'teste',
      registers: [metrics.registry],
    });
    custom.inc();
    assert.match(await metrics.render(), /custom_events_total 1/);
  });

  it('registra as métricas do LLM e do fallback (spec 010)', async () => {
    const metrics = createMetrics();
    metrics.observeLlmRequest({ provider: 'mock', result: 'ok', durationSeconds: 0.2 });
    metrics.observeLlmRequest({ provider: 'mock', result: 'ok', durationSeconds: 0.3 });
    metrics.observeLlmRequest({ provider: 'mock', result: 'error', durationSeconds: 0.01 });
    metrics.observeLlmRequest({ provider: 'mock', result: 'timeout', durationSeconds: 15 });
    metrics.countAttendanceFallback();
    metrics.countAttendanceFallback();

    const body = await metrics.render();
    assert.match(body, /llm_requests_total{provider="mock",result="ok"} 2/);
    assert.match(body, /llm_requests_total{provider="mock",result="error"} 1/);
    assert.match(body, /llm_requests_total{provider="mock",result="timeout"} 1/);
    assert.match(body, /llm_request_duration_seconds_count{provider="mock"} 4/);
    assert.match(body, /attendance_fallbacks_total 2/);
    assert.doesNotMatch(body, /clientId|userId|client_id|user_id/i);
  });

  it('não cria labels de alta cardinalidade (clientId, userId)', async () => {
    const metrics = createMetrics();
    metrics.observeHttpRequest({
      method: 'GET',
      route: '/x',
      statusCode: 200,
      durationSeconds: 0.1,
    });
    metrics.observeDbQuery({ model: 'Client', operation: 'create', durationSeconds: 0.1 });
    const body = await metrics.render();
    assert.doesNotMatch(body, /clientId|userId|client_id|user_id/i);
  });

  it('conta as recusas do rate limit por perfil e as falhas do store, sem IP nem chave em label', async () => {
    const metrics = createMetrics();
    metrics.countRateLimitRejected('admin');
    metrics.countRateLimitRejected('admin');
    metrics.countRateLimitRejected('webhook');
    metrics.countRateLimitStoreError();
    const body = await metrics.render();
    assert.match(body, /rate_limit_rejected_total{profile="admin"} 2/);
    assert.match(body, /rate_limit_rejected_total{profile="webhook"} 1/);
    assert.match(body, /rate_limit_store_errors_total 1/);
    assert.doesNotMatch(body, /\bip=|key=|clientId|userId/i);
  });

  it('métricas do canal (spec 011): webhook, entrada, status, envio e fila, só com labels fixos', async () => {
    const metrics = createMetrics();
    metrics.countWebhookRequest('whatsapp', 'ok');
    metrics.countWebhookRequest('whatsapp', 'invalid_signature');
    metrics.countChannelInbound('whatsapp', 'enqueued');
    metrics.countChannelInbound('whatsapp', 'unknown_number');
    metrics.countChannelStatus('whatsapp', 'failed');
    metrics.observeChannelSend({ channel: 'whatsapp', result: 'ok', durationSeconds: 0.12 });
    metrics.observeChannelSend({ channel: 'whatsapp', result: 'error', durationSeconds: 0.3 });
    metrics.countQueueJob('channel-inbound', 'completed');
    metrics.countQueueJob('channel-inbound', 'retried');
    const body = await metrics.render();
    assert.match(body, /webhook_requests_total{channel="whatsapp",result="ok"} 1/);
    assert.match(body, /webhook_requests_total{channel="whatsapp",result="invalid_signature"} 1/);
    assert.match(body, /channel_inbound_messages_total{channel="whatsapp",result="enqueued"} 1/);
    assert.match(
      body,
      /channel_inbound_messages_total{channel="whatsapp",result="unknown_number"} 1/,
    );
    assert.match(body, /channel_status_events_total{channel="whatsapp",status="failed"} 1/);
    assert.match(body, /channel_send_total{channel="whatsapp",result="ok"} 1/);
    assert.match(body, /channel_send_total{channel="whatsapp",result="error"} 1/);
    assert.match(body, /channel_send_duration_seconds_count{channel="whatsapp"} 2/);
    assert.match(body, /queue_jobs_total{queue="channel-inbound",result="completed"} 1/);
    assert.match(body, /queue_jobs_total{queue="channel-inbound",result="retried"} 1/);
    assert.doesNotMatch(body, /clientId|userId|phone|contact|text=/i);
  });
});
