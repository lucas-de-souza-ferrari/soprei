import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompanyId } from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { DatabaseError, type ExternalServiceError } from '../../shared/errors/index.js';
import { Result, SecretString } from '../../shared/types/index.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import type { ChannelCredentials, ChannelCredentialsResult } from '../ports/channel-credentials.js';
import {
  type FlushJob,
  type FlushSchedule,
  type InboundJob,
  type InboundJobQueue,
  NonRetryableJobError,
} from '../ports/inbound-job-queue.js';
import type { MessageSender, SendTextInput } from '../ports/message-sender.js';
import { ChannelInboundProcessor, type InboundAttendance } from './channel-inbound.processor.js';

const CONTACT = '5511987654321';
const SECRET_CONTACT = 'texto-secreto-do-contato-proc-039';
const SECRET_TEAM = 'texto-secreto-da-equipe-proc-039';
const LAST = { finalAttempt: true };
const MORE = { finalAttempt: false };

class FakeSender implements MessageSender {
  readonly calls: SendTextInput[] = [];
  sendText(
    input: SendTextInput,
  ): Promise<Result<{ channelMessageId: string }, ExternalServiceError>> {
    this.calls.push(input);
    return Promise.resolve(
      Result.ok({ channelMessageId: `wamid.SENT${String(this.calls.length)}` }),
    );
  }
}

class FakeCredentials implements ChannelCredentials {
  constructor(private readonly companies: InMemoryCompanyRepository) {}
  async forCompany(companyId: CompanyId): Promise<ChannelCredentialsResult> {
    const company = await this.companies.findById(companyId);
    if (company.whatsappPhoneNumberId === null) return { kind: 'none' };
    return {
      kind: 'ready',
      phoneNumberId: company.whatsappPhoneNumberId,
      token: new SecretString('token-de-teste'),
      tokenVersion: 1,
    };
  }
  markTokenInvalid(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeScheduler implements Pick<InboundJobQueue, 'scheduleFlush'> {
  readonly calls: { job: FlushJob; schedule: FlushSchedule }[] = [];
  scheduleFlush(job: FlushJob, schedule: FlushSchedule) {
    this.calls.push({ job, schedule });
    return Promise.resolve(Result.ok(undefined));
  }
}

function setup(attendanceOverride?: (service: AttendanceService) => InboundAttendance) {
  let time = Date.UTC(2026, 10, 12, 12);
  const now = (): Date => {
    time += 10;
    return new Date(time);
  };
  const companies = new InMemoryCompanyRepository();
  const store = new InMemoryAttendanceStore(now);
  const llm = new MockLlmProvider({ recordCalls: true });
  const logs = captureLogs();
  const echoes: string[] = [];
  const service = new AttendanceService({
    companies,
    conversations: store.conversations,
    messages: store.messages,
    unitOfWork: store,
    llm,
    logger: logs.logger,
    options: { llmTimeoutMs: 300, inFlightTimeoutMs: 60_000, now },
  });
  const sender = new FakeSender();
  const credentials = new FakeCredentials(companies);
  const scheduler = new FakeScheduler();
  const processor = new ChannelInboundProcessor({
    attendance: attendanceOverride === undefined ? service : attendanceOverride(service),
    companies,
    messages: store.messages,
    sender,
    credentials,
    connections: credentials,
    metrics: {
      countChannelStateTransition: () => undefined,
      countChannelEcho: (result) => {
        echoes.push(result);
      },
    },
    queue: scheduler,
    batch: { windowMs: 0, maxWaitMs: 0, maxMessages: 10, maxChars: 8_000 },
    logger: logs.logger,
    now,
  });
  return { companies, store, llm, logs, service, sender, scheduler, processor, echoes, now };
}

type Harness = ReturnType<typeof setup>;

async function newCompany(h: Harness, slug: string, number = '1000') {
  const created = await h.companies.create({ name: `Empresa ${slug}`, slug });
  return h.companies.update(created.id, { whatsappPhoneNumberId: number });
}

let sequence = 0;
function textJob(
  h: Harness,
  companyId: string,
  text = SECRET_CONTACT,
): Extract<InboundJob, { kind: 'text' }> {
  sequence += 1;
  return {
    kind: 'text',
    companyId,
    phoneNumberId: '1000',
    contactRef: CONTACT,
    externalId: `wamid.in.${String(sequence)}`,
    requestId: 'req-12345678',
    receivedAt: h.now().toISOString(),
    text,
  };
}

function echoJob(
  h: Harness,
  companyId: string,
  fields: Partial<Extract<InboundJob, { kind: 'echo' }>> = {},
): Extract<InboundJob, { kind: 'echo' }> {
  sequence += 1;
  return {
    kind: 'echo',
    companyId,
    phoneNumberId: '1000',
    contactRef: CONTACT,
    externalId: `wamid.echo.${String(sequence)}`,
    requestId: 'req-12345678',
    receivedAt: h.now().toISOString(),
    text: SECRET_TEAM,
    ...fields,
  };
}

const flushOf = (companyId: string): FlushJob => ({
  kind: 'flush',
  companyId,
  phoneNumberId: '1000',
  contactRef: CONTACT,
  requestId: 'req-12345678',
});

describe('ChannelInboundProcessor: job echo (spec 039)', () => {
  it('grava a mensagem HUMAN, pausa a IA e nunca envia nada ao contato', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');

    const outcome = await h.processor.process(echoJob(h, company.id), MORE);

    assert.equal(outcome, 'done');
    assert.deepEqual(
      h.store.allMessages().map((message) => message.role),
      ['HUMAN'],
    );
    assert.equal(h.sender.calls.length, 0);
    assert.deepEqual(h.echoes, ['recorded']);
  });

  it('reentrega do mesmo eco: duplicate, sem segunda mensagem', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const job = echoJob(h, company.id);
    await h.processor.process(job, MORE);
    await h.processor.process(job, MORE);
    assert.equal(h.store.allMessages().length, 1);
    assert.deepEqual(h.echoes, ['recorded', 'duplicate']);
  });

  it('eco do id de uma resposta nossa (S8, defesa): own, nada gravado', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.process(textJob(h, company.id), MORE);
    await h.processor.process(flushOf(company.id), MORE);
    assert.equal(h.sender.calls.length, 1);
    const before = h.store.allMessages().length;

    await h.processor.process(echoJob(h, company.id, { externalId: 'wamid.SENT1' }), MORE);

    assert.equal(h.store.allMessages().length, before);
    assert.deepEqual(h.echoes, ['own']);
  });

  it('empresa suspensa: descartado, nada gravado nem enviado', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.companies.update(company.id, { status: 'SUSPENDED' });
    const outcome = await h.processor.process(echoJob(h, company.id), LAST);
    assert.equal(outcome, 'discarded');
    assert.equal(h.store.allMessages().length, 0);
    assert.equal(h.sender.calls.length, 0);
  });

  it('falha transitória relança (a fila retenta) sem texto padrão; empresa removida é permanente', async () => {
    const h = setup((service) => ({
      acceptInboundMessage: (c, i, o) => service.acceptInboundMessage(c, i, o),
      respondToPending: (c, r, l, o) => service.respondToPending(c, r, l, o),
      hasPendingMessages: (c, r) => service.hasPendingMessages(c, r),
      recordHumanEcho: () => Promise.reject(new DatabaseError('banco fora')),
    }));
    const company = await newCompany(h, 'alfa');
    await assert.rejects(h.processor.process(echoJob(h, company.id), LAST), DatabaseError);
    assert.equal(h.sender.calls.length, 0, 'eco nunca gera texto padrão ao contato');

    const removed = setup();
    await assert.rejects(
      removed.processor.process(echoJob(removed, '00000000-0000-7000-8000-0000000000aa'), LAST),
      NonRetryableJobError,
    );
    assert.equal(removed.sender.calls.length, 0);
  });

  it('o job que falha sem passar pelo handler não envia nada ao contato', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.handleUnprocessedFailure(echoJob(h, company.id));
    assert.equal(h.sender.calls.length, 0);
  });
});

describe('ChannelInboundProcessor: flush com a IA pausada (spec 039)', () => {
  it('mensagem do contato durante a pausa: sem LLM, sem resposta e sem envio', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.process(echoJob(h, company.id), MORE);
    await h.processor.process(textJob(h, company.id), MORE);

    const outcome = await h.processor.process(flushOf(company.id), MORE);

    assert.equal(outcome, 'done');
    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.sender.calls.length, 0);
    assert.equal(h.store.allMessages().filter((m) => m.role === 'ASSISTANT').length, 0);
  });

  it('eco com o flush já agendado (antes dele rodar) impede a resposta', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.process(textJob(h, company.id), MORE);
    assert.equal(h.scheduler.calls.length, 1, 'o flush ficou agendado');
    await h.processor.process(echoJob(h, company.id), MORE);

    await h.processor.process(flushOf(company.id), MORE);

    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.sender.calls.length, 0);
    assert.equal(h.store.allMessages().filter((m) => m.role === 'USER').length, 1);
  });

  it('pausa entre a gravação e o envio: a resposta fica gravada sem sentAt e não sai', async () => {
    let paused = false;
    const h = setup((service) => ({
      acceptInboundMessage: (c, i, o) => service.acceptInboundMessage(c, i, o),
      respondToPending: async (c, r, l, o) => {
        const response = await service.respondToPending(c, r, l, o);
        paused = true;
        return response;
      },
      hasPendingMessages: (c, r) => service.hasPendingMessages(c, r),
      isAiPausedFor: () => Promise.resolve(paused),
    }));
    const company = await newCompany(h, 'alfa');
    await h.processor.process(textJob(h, company.id), MORE);

    const outcome = await h.processor.process(flushOf(company.id), MORE);

    assert.equal(outcome, 'done');
    assert.equal(h.sender.calls.length, 0);
    const replies = h.store.allMessages().filter((m) => m.role === 'ASSISTANT');
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.sentAt, null);
  });

  it('nada de texto, telefone ou wamid nos logs do fluxo eco/pausa', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.process(echoJob(h, company.id, { externalId: 'wamid.SEGREDOPROC' }), MORE);
    await h.processor.process(textJob(h, company.id), MORE);
    await h.processor.process(flushOf(company.id), MORE);
    const raw = h.logs.raw();
    for (const secret of [SECRET_TEAM, SECRET_CONTACT, CONTACT, 'wamid.SEGREDOPROC']) {
      assert.equal(logContains(raw, secret), false, secret);
    }
  });
});
