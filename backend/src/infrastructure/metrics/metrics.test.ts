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
    metrics.observeDbQuery({ model: 'Company', operation: 'create', durationSeconds: 0.003 });
    metrics.observeDbQuery({ model: 'Company', operation: 'create', durationSeconds: 0.004 });
    metrics.observeDbQuery({ model: 'Conversation', operation: 'findMany', durationSeconds: 0.5 });
    const body = await metrics.render();
    assert.match(body, /db_query_duration_seconds_count\{model="Company",operation="create"\} 2/);
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
    assert.doesNotMatch(body, /companyId|membershipId|company_id|membership_id/i);
  });

  it('registra tokens e os resultados refusal e truncated do LLM (spec 014), sem label de empresa', async () => {
    const metrics = createMetrics();
    metrics.observeLlmRequest({ provider: 'anthropic', result: 'refusal', durationSeconds: 0.2 });
    metrics.observeLlmRequest({ provider: 'anthropic', result: 'truncated', durationSeconds: 0.3 });
    metrics.observeLlmTokens({ provider: 'anthropic', type: 'input', tokens: 100 });
    metrics.observeLlmTokens({ provider: 'anthropic', type: 'input', tokens: 20 });
    metrics.observeLlmTokens({ provider: 'anthropic', type: 'output', tokens: 30 });
    metrics.observeLlmTokens({ provider: 'anthropic', type: 'cache_read', tokens: 0 });
    metrics.observeLlmTokens({ provider: 'anthropic', type: 'cache_read', tokens: Number.NaN });

    const body = await metrics.render();
    assert.match(body, /llm_requests_total{provider="anthropic",result="refusal"} 1/);
    assert.match(body, /llm_requests_total{provider="anthropic",result="truncated"} 1/);
    assert.match(body, /llm_tokens_total{provider="anthropic",type="input"} 120/);
    assert.match(body, /llm_tokens_total{provider="anthropic",type="output"} 30/);
    assert.doesNotMatch(body, /llm_tokens_total{provider="anthropic",type="cache_read"} [1-9]/);
    assert.doesNotMatch(body, /companyId|membershipId|company_id|membership_id/i);
  });

  it('registra o tamanho e o resultado das respostas de lote (spec 013), sem label de empresa', async () => {
    const metrics = createMetrics();
    metrics.observeAttendanceBatch({ size: 1, result: 'answered' });
    metrics.observeAttendanceBatch({ size: 3, result: 'answered' });
    metrics.observeAttendanceBatch({ size: 10, result: 'capped' });
    metrics.observeAttendanceBatch({ size: 0, result: 'empty' });
    metrics.countUnsentReply();
    metrics.countUnsentReply();

    const body = await metrics.render();
    assert.match(body, /attendance_batches_total{result="answered"} 2/);
    assert.match(body, /attendance_batches_total{result="capped"} 1/);
    assert.match(body, /attendance_batches_total{result="empty"} 1/);
    assert.doesNotMatch(body, /unsent_previous/);
    assert.match(body, /attendance_unsent_replies_total 2/);
    // `empty` não entra no histograma: 3 respostas, 14 mensagens no total.
    assert.match(body, /attendance_batch_size_count 3/);
    assert.match(body, /attendance_batch_size_sum 14/);
    for (const bucket of ['1', '2', '3', '5', '10', '25', '50']) {
      assert.match(body, new RegExp(`attendance_batch_size_bucket{le="${bucket}"} `));
    }
    assert.match(body, /attendance_batch_size_bucket{le="3"} 2/);
    assert.doesNotMatch(body, /companyId|membershipId|company_id|membership_id/i);
  });

  it('não cria labels de alta cardinalidade (companyId, membershipId)', async () => {
    const metrics = createMetrics();
    metrics.observeHttpRequest({
      method: 'GET',
      route: '/x',
      statusCode: 200,
      durationSeconds: 0.1,
    });
    metrics.observeDbQuery({ model: 'Company', operation: 'create', durationSeconds: 0.1 });
    const body = await metrics.render();
    assert.doesNotMatch(body, /companyId|membershipId|company_id|membership_id/i);
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
    assert.doesNotMatch(body, /\bip=|key=|companyId|membershipId/i);
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
    assert.doesNotMatch(body, /companyId|membershipId|phone|contact|text=/i);
  });

  it('métricas de conexão do canal (spec 015): conjuntos fixos de labels, sem ids nem token', async () => {
    const metrics = createMetrics();
    metrics.countChannelConnection('connect', 'ok');
    metrics.countChannelConnection('connect', 'wrong_app');
    metrics.countChannelConnection('disconnect', 'unsubscribe_failed');
    metrics.countChannelStateTransition('token_invalid');
    metrics.countChannelCredentialError('tampered');
    const body = await metrics.render();
    assert.match(body, /channel_connections_total{action="connect",result="ok"} 1/);
    assert.match(body, /channel_connections_total{action="connect",result="wrong_app"} 1/);
    assert.match(
      body,
      /channel_connections_total{action="disconnect",result="unsubscribe_failed"} 1/,
    );
    assert.match(body, /channel_state_transitions_total{to="token_invalid"} 1/);
    assert.match(body, /channel_credential_errors_total{reason="tampered"} 1/);
    assert.doesNotMatch(body, /companyId|waba|phone|token="/i);
  });

  it('métrica de persona (spec 023): só o label action, nunca texto, id nem tamanho', async () => {
    const metrics = createMetrics();
    metrics.countCompanyPersonaUpdate('set');
    metrics.countCompanyPersonaUpdate('set');
    metrics.countCompanyPersonaUpdate('cleared');
    const body = await metrics.render();
    assert.match(body, /company_persona_updates_total{action="set"} 2/);
    assert.match(body, /company_persona_updates_total{action="cleared"} 1/);
    const labels = body
      .split('\n')
      .filter((line) => line.startsWith('company_persona_updates_total{'))
      .map((line) => line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/="[^"]*"/g, ''));
    assert.deepEqual([...new Set(labels)], ['action']);
  });

  it('métricas de autorização e de gestão de usuários (spec 008): só labels de conjunto fixo', async () => {
    const metrics = createMetrics();
    metrics.countAuthzDenial('membership:manage');
    metrics.countAuthzDenial('membership:manage');
    metrics.countAuthzDenial('conversation:simulate');
    metrics.countMembershipAdminAction('MEMBERSHIP_CREATED');
    metrics.countMembershipAdminAction('MEMBERSHIP_ROLE_CHANGED');
    const body = await metrics.render();
    assert.match(body, /authz_denials_total{permission="membership:manage"} 2/);
    assert.match(body, /authz_denials_total{permission="conversation:simulate"} 1/);
    assert.match(body, /membership_admin_actions_total{action="MEMBERSHIP_CREATED"} 1/);
    assert.match(body, /membership_admin_actions_total{action="MEMBERSHIP_ROLE_CHANGED"} 1/);
    // Só nomes de label importam (a métrica account_password_reset_emails_total, spec 021, tem "emails" no nome).
    assert.doesNotMatch(body, /{[^}]*(companyId|membershipId|actorMembershipId|email)/i);
  });
});

describe('account_verification_sends_total', () => {
  it('conta envios de confirmação só por resultado (sem id nem e-mail)', async () => {
    const metrics = createMetrics();
    metrics.countVerificationEmail('sent');
    metrics.countVerificationEmail('failed');
    metrics.countVerificationEmail('failed');
    const body = await metrics.render();
    assert.match(body, /account_verification_sends_total\{result="sent"\} 1/);
    assert.match(body, /account_verification_sends_total\{result="failed"\} 2/);
  });
});

describe('account_verification_attempts_total', () => {
  it('conta tentativas de confirmação só por resultado fixo (sem id, e-mail, IP nem código)', async () => {
    const metrics = createMetrics();
    metrics.countVerificationAttempt('verified');
    metrics.countVerificationAttempt('wrong');
    metrics.countVerificationAttempt('wrong');
    metrics.countVerificationAttempt('exhausted');
    metrics.countVerificationAttempt('unavailable');
    const body = await metrics.render();
    assert.ok(body.includes('account_verification_attempts_total{result="verified"} 1'));
    assert.ok(body.includes('account_verification_attempts_total{result="wrong"} 2'));
    assert.ok(body.includes('account_verification_attempts_total{result="exhausted"} 1'));
    assert.ok(body.includes('account_verification_attempts_total{result="unavailable"} 1'));
    const lines = body
      .split(String.fromCharCode(10))
      .filter((line) => line.startsWith('account_verification_attempts_total{'));
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.match(line, /^account_verification_attempts_total\{result="[a-z]+"\} [0-9]+$/);
    }
  });
});

describe('métricas da recuperação de senha e do expurgo (spec 021)', () => {
  it('conta só por labels fixos, sem id, e-mail, IP nem código', async () => {
    const metrics = createMetrics();
    metrics.countPasswordResetRequest('issued');
    metrics.countPasswordResetRequest('ignored');
    metrics.countPasswordResetRequest('ignored');
    for (const result of ['reset', 'wrong', 'exhausted', 'unavailable', 'revoke_failed'] as const) {
      metrics.countPasswordResetAttempt(result);
    }
    metrics.countPasswordResetEmail('code', 'sent');
    metrics.countPasswordResetEmail('code', 'failed');
    metrics.countPasswordResetEmail('notice', 'sent');
    metrics.countAccountsPurged(0);
    metrics.countAccountsPurged(3);
    metrics.countAccountPurgeRun('ok');
    metrics.countAccountPurgeRun('error');
    const body = await metrics.render();
    assert.ok(body.includes('account_password_reset_requests_total{result="issued"} 1'));
    assert.ok(body.includes('account_password_reset_requests_total{result="ignored"} 2'));
    for (const result of ['reset', 'wrong', 'exhausted', 'unavailable', 'revoke_failed']) {
      assert.ok(body.includes(`account_password_reset_attempts_total{result="${result}"} 1`));
    }
    assert.ok(body.includes('account_password_reset_emails_total{kind="code",result="sent"} 1'));
    assert.ok(body.includes('account_password_reset_emails_total{kind="code",result="failed"} 1'));
    assert.ok(body.includes('account_password_reset_emails_total{kind="notice",result="sent"} 1'));
    assert.ok(body.includes('account_purged_total 3'));
    assert.ok(body.includes('account_purge_runs_total{result="ok"} 1'));
    assert.ok(body.includes('account_purge_runs_total{result="error"} 1'));
    const labelled = body
      .split(String.fromCharCode(10))
      .filter((line) => /^account_(password_reset|purge)/.test(line) && line.includes('{'));
    for (const line of labelled) {
      assert.match(line, /^[a-z_]+\{(result|kind)="[a-z_]+"(,result="[a-z_]+")?\} [0-9]+$/);
    }
  });
});

describe('métricas das ferramentas de agenda da IA (spec 028)', () => {
  it('contam chamadas, turnos e rodadas só com labels de conjunto fixo', async () => {
    const metrics = createMetrics();
    metrics.countScheduleToolCall('listar_horarios', 'ok');
    metrics.countScheduleToolCall('unknown', 'error');
    metrics.countScheduleToolTurn('used');
    metrics.countScheduleToolTurn('round_cap');
    metrics.countScheduleToolCall('solicitar_agendamento', 'slot_taken');
    metrics.countScheduleToolCall('remarcar_agendamento', 'limit');
    metrics.countScheduleToolTurn('deterministic_summary');
    metrics.countScheduleToolTurn('guard_replaced');
    metrics.countScheduleToolTurn('disabled_fail_safe');
    metrics.observeScheduleToolRounds(2);
    const body = await metrics.render();
    assert.match(body, /schedule_tool_calls_total\{tool="listar_horarios",result="ok"\} 1/);
    assert.match(body, /schedule_tool_calls_total\{tool="unknown",result="error"\} 1/);
    assert.match(body, /schedule_tool_turns_total\{result="used"\} 1/);
    assert.match(body, /schedule_tool_turns_total\{result="round_cap"\} 1/);
    assert.match(
      body,
      /schedule_tool_calls_total{tool="solicitar_agendamento",result="slot_taken"} 1/,
    );
    assert.match(body, /schedule_tool_calls_total{tool="remarcar_agendamento",result="limit"} 1/);
    for (const result of ['deterministic_summary', 'guard_replaced', 'disabled_fail_safe']) {
      assert.ok(body.includes(`schedule_tool_turns_total{result="${result}"} 1`), result);
    }
    assert.match(body, /schedule_tool_rounds_count 1/);
    assert.match(body, /schedule_tool_rounds_bucket\{le="2"\} 1/);
  });
});
