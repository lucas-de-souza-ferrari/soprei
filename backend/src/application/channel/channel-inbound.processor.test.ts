import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CredentialDecryptionError,
  DatabaseError,
  ExternalServiceError,
  ForbiddenError,
  ValidationError,
} from '../../shared/errors/index.js';
import { Result, SecretString } from '../../shared/types/index.js';
import { steppingClock } from '../../test-support/clock.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { ATTENDANCE_FALLBACK_TEXT, AttendanceService } from '../attendance/attendance.service.js';
import type {
  FlushJob,
  FlushSchedule,
  InboundJob,
  InboundJobOutcome,
  InboundJobQueue,
} from '../ports/inbound-job-queue.js';
import { flushKey, NonRetryableJobError } from '../ports/inbound-job-queue.js';
import {
  MessageSendError,
  type MessageSender,
  type SendTextInput,
} from '../ports/message-sender.js';
import type { ChannelCredentials, ChannelCredentialsResult } from '../ports/channel-credentials.js';
import type { CompanyId } from '../../domain/index.js';
import { CHANNEL_NOTICE_TEXTS } from './channel-texts.js';
import {
  type ChannelBatchSettings,
  ChannelInboundProcessor,
  type InboundAttendance,
} from './channel-inbound.processor.js';

const IN_FLIGHT_MS = 60_000;
const SECRET_TEXT = 'texto-secreto-do-contato-9f3';
const CONTACT = '5511987654321';
const WAMID = `wamid.${Buffer.from(`\u001c\u0018\u000b${CONTACT}`).toString('base64')}`;
const PERSONA = 'persona-secreta-da-empresa-77';

/** Servidor de envio de mentira: registra o que recebeu e responde conforme o roteiro. */
class FakeSender implements MessageSender {
  readonly calls: SendTextInput[] = [];
  private readonly scripted: Result<{ channelMessageId: string }, ExternalServiceError>[] = [];
  private sequence = 0;

  script(...results: Result<{ channelMessageId: string }, ExternalServiceError>[]): void {
    this.scripted.push(...results);
  }

  sendText(
    input: SendTextInput,
  ): Promise<Result<{ channelMessageId: string }, ExternalServiceError>> {
    this.calls.push(input);
    this.sequence += 1;
    return Promise.resolve(
      this.scripted.shift() ??
        Result.ok({ channelMessageId: `wamid.SENT${String(this.sequence)}` }),
    );
  }
}

/**
 * Credenciais de mentira (spec 015): número do banco (a empresa em memória), token por empresa e a
 * marca `TOKEN_INVALID` que o processador grava ao receber 190. Registra as leituras por empresa.
 */
class FakeCredentials implements ChannelCredentials {
  readonly invalid = new Set<string>();
  readonly marks: { companyId: string; tokenVersion: number }[] = [];
  tokenVersion = 1;

  constructor(private readonly companies: InMemoryCompanyRepository) {}

  tokenOf(companyId: string): string {
    return `token-do-empresa-${companyId}`;
  }

  async forCompany(companyId: CompanyId): Promise<ChannelCredentialsResult> {
    const company = await this.companies.findById(companyId);
    if (company.whatsappPhoneNumberId === null) return { kind: 'none' };
    if (this.invalid.has(companyId)) return { kind: 'token_invalid' };
    return {
      kind: 'ready',
      phoneNumberId: company.whatsappPhoneNumberId,
      token: new SecretString(this.tokenOf(companyId)),
      tokenVersion: this.tokenVersion,
    };
  }

  markTokenInvalid(companyId: CompanyId, tokenVersion: number): Promise<boolean> {
    this.marks.push({ companyId, tokenVersion });
    this.invalid.add(companyId);
    return Promise.resolve(true);
  }
}

/** Fila de mentira: guarda os agendamentos de `flush` que o processador pede. */
class FakeScheduler implements Pick<InboundJobQueue, 'scheduleFlush'> {
  readonly calls: { job: FlushJob; schedule: FlushSchedule }[] = [];
  /** Erro devolvido (como `Result.err`) nos próximos agendamentos, enquanto definido. */
  failWith: ExternalServiceError | undefined;

  scheduleFlush(
    job: FlushJob,
    schedule: FlushSchedule,
  ): Promise<Result<void, ExternalServiceError>> {
    this.calls.push({ job, schedule });
    return Promise.resolve(
      this.failWith === undefined ? Result.ok(undefined) : Result.err(this.failWith),
    );
  }
}

const BATCH: ChannelBatchSettings = {
  windowMs: 5_000,
  maxWaitMs: 20_000,
  maxMessages: 10,
  maxChars: 8_000,
};

const retryable = (): MessageSendError =>
  new MessageSendError({ reason: 'http_error', retryable: true, httpStatus: 503 });
const permanent = (code = 190): MessageSendError =>
  new MessageSendError({
    reason: 'http_error',
    retryable: false,
    httpStatus: 401,
    providerCode: code,
    providerType: 'OAuthException',
  });

interface Harness {
  readonly companies: InMemoryCompanyRepository;
  readonly store: InMemoryAttendanceStore;
  readonly llm: MockLlmProvider;
  readonly sender: FakeSender;
  readonly credentials: FakeCredentials;
  readonly scheduler: FakeScheduler;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly processor: ChannelInboundProcessor;
  readonly service: AttendanceService;
  advance(ms: number): void;
}

function setup(
  overrides: {
    attendance?: Partial<InboundAttendance>;
    messages?: Partial<InMemoryAttendanceStore['messages']>;
    batch?: Partial<ChannelBatchSettings>;
  } = {},
): Harness {
  let offset = 0;
  // 10 ms a cada leitura: as mensagens nunca caem no mesmo instante (a resposta do lote fica 1 ms
  // depois da última mensagem e antes de qualquer outra).
  const step = steppingClock(10);
  const now = (): Date => new Date(step().getTime() + offset);
  const companies = new InMemoryCompanyRepository();
  const store = new InMemoryAttendanceStore(now);
  const llm = new MockLlmProvider({ recordCalls: true });
  const logs = captureLogs();
  const service = new AttendanceService({
    companies,
    conversations: store.conversations,
    messages: store.messages,
    unitOfWork: store,
    llm,
    logger: logs.logger,
    options: { llmTimeoutMs: 300, inFlightTimeoutMs: IN_FLIGHT_MS, now },
  });
  const sender = new FakeSender();
  const credentials = new FakeCredentials(companies);
  const scheduler = new FakeScheduler();
  const processor = new ChannelInboundProcessor({
    attendance:
      overrides.attendance === undefined ? service : { ...bind(service), ...overrides.attendance },
    companies,
    messages: { ...store.messages, ...overrides.messages },
    sender,
    credentials,
    connections: credentials,
    queue: scheduler,
    batch: { ...BATCH, ...overrides.batch },
    logger: logs.logger,
    now,
  });
  return {
    companies,
    store,
    llm,
    sender,
    credentials,
    scheduler,
    logs,
    processor,
    service,
    advance(ms) {
      offset += ms;
    },
  };
}

/** Os métodos do serviço de atendimento ligados à instância (para poder sobrescrever só alguns). */
function bind(service: AttendanceService): InboundAttendance {
  return {
    acceptInboundMessage: (companyId, input) => service.acceptInboundMessage(companyId, input),
    respondToPending: (companyId, contactRef, limits, options) =>
      service.respondToPending(companyId, contactRef, limits, options),
    hasPendingMessages: (companyId, contactRef) =>
      service.hasPendingMessages(companyId, contactRef),
  };
}

/** Número do negócio com que cada empresa foi criado: o `phoneNumberId` que o job leva ao ser enfileirado. */
const jobPhone = new Map<string, string>();

async function newCompany(h: Harness, slug: string, phoneNumberId: string | null = '1000') {
  const created = await h.companies.create({ name: `Empresa ${slug}`, slug });
  jobPhone.set(created.id, phoneNumberId ?? '1000');
  return h.companies.update(created.id, {
    persona: `${PERSONA} ${slug}`,
    whatsappPhoneNumberId: phoneNumberId,
  });
}

const textJob = (
  companyId: string,
  overrides: Partial<Extract<InboundJob, { kind: 'text' }>> = {},
): Extract<InboundJob, { kind: 'text' }> => ({
  kind: 'text',
  companyId,
  phoneNumberId: jobPhone.get(companyId) ?? '1000',
  contactRef: CONTACT,
  text: SECRET_TEXT,
  externalId: WAMID,
  requestId: 'req-12345678',
  ...overrides,
});

const noticeJob = (
  companyId: string,
  reason: 'unsupported_type' | 'invalid_text' = 'unsupported_type',
): InboundJob => ({
  kind: 'notice',
  companyId,
  phoneNumberId: jobPhone.get(companyId) ?? '1000',
  contactRef: CONTACT,
  externalId: WAMID,
  requestId: 'req-12345678',
  reason,
});

/** O `flush` do contato que enviou este job de texto. */
const flushOf = (job: Extract<InboundJob, { kind: 'text' }>): FlushJob => ({
  kind: 'flush',
  companyId: job.companyId,
  phoneNumberId: job.phoneNumberId,
  contactRef: job.contactRef,
  requestId: job.requestId,
});

/**
 * O fluxo de um contato que escreveu: etapa "aceitar" (job `text`) e, se ela terminou normalmente,
 * o `flush` agendado (aqui rodado na hora, sem esperar a janela). Devolve o resultado da última
 * etapa que rodou; erros de qualquer etapa sobem.
 */
async function flow(
  h: Harness,
  job: Extract<InboundJob, { kind: 'text' }>,
  context: { finalAttempt: boolean },
): Promise<InboundJobOutcome> {
  const accepted = await h.processor.process(job, context);
  if (accepted !== 'done') return accepted;
  return h.processor.process(flushOf(job), context);
}

/** Texto passa pelo fluxo completo (aceitar e responder); aviso roda direto. */
function run(h: Harness, job: InboundJob, context: { finalAttempt: boolean }) {
  return job.kind === 'text' ? flow(h, job, context) : h.processor.process(job, context);
}

const LAST: { finalAttempt: boolean } = { finalAttempt: true };
const MORE: { finalAttempt: boolean } = { finalAttempt: false };

describe('ChannelInboundProcessor: job de texto', () => {
  it('atende, envia a resposta pelo número da empresa no banco e grava a marca de envio', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');

    const outcome = await flow(h, textJob(company.id), MORE);

    assert.equal(outcome, 'done');
    assert.equal(h.sender.calls.length, 1);
    const [call] = h.sender.calls;
    assert.equal(call?.phoneNumberId, '555001');
    assert.equal(call.to, CONTACT);
    assert.match(call.text, /^\[mock\] Recebi: texto-secreto-do-contato-9f3/);
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.content, call.text);
    assert.ok(reply.sentAt instanceof Date);
    assert.equal(reply.channelMessageId, 'wamid.SENT1');
    assert.equal(h.store.allMessages().length, 2);
  });

  it('retentativa depois de envio concluído não envia de novo nem chama o LLM', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');

    await flow(h, textJob(company.id), MORE);
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.llm.calls.length, 1);

    const again = await flow(h, textJob(company.id), MORE);
    assert.equal(again, 'done');
    assert.equal(h.sender.calls.length, 1, 'não reenvia');
    assert.equal(h.llm.calls.length, 1, 'não chama o LLM de novo');
    assert.equal(h.store.allMessages().length, 2, 'uma só resposta gravada');
  });

  it('o número do envio é o do banco: campos extras de um job adulterado (número, destinatário) são ignorados', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    const forged = {
      ...textJob(company.id),
      phone_number_id: '999999',
      sendFrom: '999999',
      to: '5500000000000',
    } as unknown as InboundJob;

    await run(h, forged, MORE);

    assert.equal(h.sender.calls[0]?.phoneNumberId, '555001');
    assert.equal(h.sender.calls[0].to, CONTACT);
  });

  it('job cujo phoneNumberId não é o da empresa no banco (adulterado): erro permanente, nada é enviado, log sem conteúdo', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    const other = await newCompany(h, 'beta', '555002');

    for (const job of [textJob(company.id, { phoneNumberId: '555002' }), noticeJob(company.id)]) {
      const forged = { ...job, phoneNumberId: other.whatsappPhoneNumberId ?? '' };
      await assert.rejects(
        run(h, forged, MORE),
        (error: unknown) => error instanceof NonRetryableJobError,
      );
    }
    assert.equal(
      h.sender.calls.length,
      0,
      'nada sai, nem pelo número do job nem pelo do outra empresa',
    );
    const line = h.logs
      .lines()
      .find((entry) => String(entry.msg).includes('o número da empresa mudou'));
    assert.equal(line?.level, 50);
    assert.equal(line.companyId, company.id);
    const raw = h.logs.raw();
    for (const secret of ['555001', '555002', CONTACT, SECRET_TEXT, WAMID]) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
  });

  it('número trocado entre enfileirar e processar: texto e aviso não enviam (nem o texto padrão)', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    const text = textJob(company.id);
    const notice = noticeJob(company.id);
    // O dono troca o número da empresa depois de a mensagem entrar na fila.
    await h.companies.update(company.id, { whatsappPhoneNumberId: '555777' });

    await assert.rejects(
      run(h, text, MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    await assert.rejects(
      run(h, notice, MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
    // A resposta ficou gravada sem envio (visível na API administrativa).
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
  });

  it('empresa sem número no banco: descarta com log, sem enviar; a resposta fica gravada sem envio', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', null);

    const outcome = await flow(h, textJob(company.id), MORE);

    assert.equal(outcome, 'discarded');
    assert.equal(h.sender.calls.length, 0);
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
    const line = h.logs.lines().find((entry) => String(entry.msg).includes('sem número'));
    assert.equal(line?.companyId, company.id);
  });

  it('companyId malformado no job é erro permanente', async () => {
    const h = setup();
    await assert.rejects(
      flow(h, textJob('nao-e-uuid'), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
  });

  it('LLM com falha e com timeout: o fallback é gravado E enviado', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    for (const marker of ['[[mock:fail]]', '[[mock:hang]]']) {
      const h = setup();
      const company = await newCompany(h, 'alfa');
      await flow(h, textJob(company.id, { text: `oi ${marker}` }), MORE);
      assert.equal(h.sender.calls.length, 1, marker);
      assert.equal(h.sender.calls[0]?.text, ATTENDANCE_FALLBACK_TEXT);
      const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
      assert.equal(reply?.isFallback, true);
      assert.ok(reply.sentAt instanceof Date, `${marker}: marca de envio`);
    }
  });
});

describe('ChannelInboundProcessor: falhas de envio', () => {
  it('falha transitória: relança o mesmo erro (a fila retenta); nada de fallback; resposta gravada sem envio', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const failure = retryable();
    h.sender.script(Result.err(failure));

    await assert.rejects(flow(h, textJob(company.id), MORE), (error: unknown) => {
      return error === failure;
    });
    assert.equal(h.sender.calls.length, 1, 'só a tentativa da resposta, sem fallback');
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);

    // A retentativa envia a MESMA resposta (sem novo LLM) e confirma o envio.
    const outcome = await flow(h, textJob(company.id), MORE);
    assert.equal(outcome, 'done');
    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.sender.calls.length, 2);
    assert.equal(h.sender.calls[1]?.text, h.sender.calls[0]?.text);
    assert.equal(h.store.allMessages().length, 2);
    assert.ok(h.store.allMessages().find((m) => m.role === 'ASSISTANT')?.sentAt instanceof Date);
  });

  it('falha permanente: NonRetryableJobError, sem fallback, resposta sem envio, log error com companyId e código', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    h.sender.script(Result.err(permanent(131047)));

    await assert.rejects(
      flow(h, textJob(company.id), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 1, 'sem fallback quando a resposta já existe');
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
    const line = h.logs.lines().find((entry) => String(entry.msg).includes('envio recusado'));
    assert.equal(line?.level, 50);
    assert.equal(line.companyId, company.id);
    assert.equal(line.providerCode, 131047);
    assert.equal(typeof line.flushRef, 'string');
  });

  it('falha transitória na última tentativa também não manda fallback (a resposta existe)', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    h.sender.script(Result.err(retryable()));
    await assert.rejects(flow(h, textJob(company.id), LAST));
    assert.equal(h.sender.calls.length, 1);
  });

  it('a falha ao gravar a marca de envio só gera log error: o contato já recebeu, nada é relançado', async () => {
    const failingMark = setup({
      messages: {
        markSent: () => Promise.reject(new DatabaseError('banco caiu na marca')),
      },
    });
    const company = await newCompany(failingMark, 'alfa');
    const outcome = await flow(failingMark, textJob(company.id), MORE);
    assert.equal(outcome, 'done');
    assert.equal(failingMark.sender.calls.length, 1);
    const line = failingMark.logs
      .lines()
      .find((entry) => String(entry.msg).includes('marca de envio'));
    assert.equal(line?.level, 50);
    assert.equal(line.companyId, company.id);
  });
});

describe('ChannelInboundProcessor: falha do atendimento antes de existir resposta', () => {
  const failing = (error: Error): Partial<InboundAttendance> => ({
    acceptInboundMessage: () => Promise.reject(error),
  });

  it('transitória com tentativas restantes: relança sem enviar nada', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: failing(error) });
    const company = await newCompany(h, 'alfa');
    await assert.rejects(flow(h, textJob(company.id), MORE), (e: unknown) => e === error);
    assert.equal(h.sender.calls.length, 0);
  });

  it('na última tentativa: envia o texto padrão ao contato e relança o erro', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: failing(error) });
    const company = await newCompany(h, 'alfa', '555009');
    await assert.rejects(flow(h, textJob(company.id), LAST), (e: unknown) => e === error);
    assert.equal(h.sender.calls.length, 1);
    assert.deepEqual(h.sender.calls[0], {
      phoneNumberId: '555009',
      accessToken: new SecretString(h.credentials.tokenOf(company.id)),
      to: CONTACT,
      text: ATTENDANCE_FALLBACK_TEXT,
    });
  });

  it('se o envio do texto padrão também falha, só loga (o erro original segue)', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: failing(error) });
    const company = await newCompany(h, 'alfa');
    h.sender.script(Result.err(permanent()));
    await assert.rejects(flow(h, textJob(company.id), LAST), (e: unknown) => e === error);
    assert.equal(h.sender.calls.length, 1, 'uma única tentativa');
    const warn = h.logs
      .lines()
      .find((entry) => String(entry.msg).includes('texto padrão ao contato'));
    assert.ok(warn !== undefined);
  });

  it('erro permanente que não é suspensão (entrada inválida): sem retentativa, com o texto padrão (inalterado)', async () => {
    const h = setup({ attendance: failing(new ValidationError('entrada inválida')) });
    const company = await newCompany(h, 'alfa');
    await assert.rejects(
      flow(h, textJob(company.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]?.text, ATTENDANCE_FALLBACK_TEXT);
  });

  it('empresa removida depois de enfileirar: permanente, e sem número não há por onde responder', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.companies.delete(company.id);
    await assert.rejects(
      flow(h, textJob(company.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
  });

  it('queda entre gravar a mensagem e agendar o flush: a retentativa do job text agenda de novo e a mensagem é respondida uma vez', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    h.scheduler.failWith = new ExternalServiceError('Redis fora');

    await assert.rejects(h.processor.process(textJob(company.id), MORE), ExternalServiceError);
    // A mensagem ficou gravada e pendente, sem LLM nem envio.
    assert.equal(h.store.allMessages().length, 1);
    assert.equal(h.llm.calls.length, 0);

    h.scheduler.failWith = undefined;
    assert.equal(await h.processor.process(textJob(company.id), MORE), 'done');
    const last = h.scheduler.calls.at(-1);
    assert.equal(last?.schedule.mode, 'ensure', 'a retentativa só garante o flush');
    assert.equal(h.store.allMessages().length, 1, 'sem segunda gravação');

    assert.equal(await h.processor.process(flushOf(textJob(company.id)), MORE), 'done');
    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.sender.calls.length, 1);
  });
});

describe('ChannelInboundProcessor: job de aviso', () => {
  it('envia o texto constante pelo número da empresa, sem gravar mensagem nem chamar o LLM', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');

    for (const reason of ['unsupported_type', 'invalid_text'] as const) {
      assert.equal(await h.processor.process(noticeJob(company.id, reason), MORE), 'done');
    }

    assert.deepEqual(
      h.sender.calls.map((call) => call.text),
      [CHANNEL_NOTICE_TEXTS.unsupported_type, CHANNEL_NOTICE_TEXTS.invalid_text],
    );
    assert.ok(
      h.sender.calls.every((call) => call.phoneNumberId === '555001' && call.to === CONTACT),
    );
    assert.equal(h.store.allMessages().length, 0);
    assert.equal(h.store.allConversations().length, 0);
    assert.equal(h.llm.calls.length, 0);
  });

  it('segue as mesmas regras de erro: transitório relança, permanente não retenta, sem número descarta', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const failure = retryable();
    h.sender.script(Result.err(failure), Result.err(permanent()));
    await assert.rejects(
      h.processor.process(noticeJob(company.id), MORE),
      (e: unknown) => e === failure,
    );
    await assert.rejects(
      h.processor.process(noticeJob(company.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    // Aviso nunca dispara o texto padrão (não há atendimento).
    assert.equal(h.sender.calls.length, 2);

    const noNumber = await newCompany(h, 'beta', null);
    assert.equal(await h.processor.process(noticeJob(noNumber.id), MORE), 'discarded');
    assert.equal(h.sender.calls.length, 2);
  });
});

describe('ChannelInboundProcessor: job que falhou sem passar pelo handler (parado)', () => {
  it('sem resposta gravada: envia o texto padrão pelo número do banco, uma vez', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');

    await h.processor.handleUnprocessedFailure(textJob(company.id));

    assert.deepEqual(h.sender.calls, [
      {
        phoneNumberId: '555001',
        accessToken: new SecretString(h.credentials.tokenOf(company.id)),
        to: CONTACT,
        text: ATTENDANCE_FALLBACK_TEXT,
      },
    ]);
    const line = h.logs.lines().find((entry) => String(entry.msg).includes('sem resposta gravada'));
    assert.equal(line?.level, 50);
    assert.equal(line.companyId, company.id);
  });

  it('mensagem gravada mas ainda sem resposta (caiu no meio do LLM): também envia o texto padrão', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const conversation = await h.store.conversations.findOrCreateByContact(company.id, CONTACT);
    await h.store.messages.create(company.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: SECRET_TEXT,
      externalId: WAMID,
    });
    await h.processor.handleUnprocessedFailure(textJob(company.id));
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]?.text, ATTENDANCE_FALLBACK_TEXT);
  });

  it('com resposta já gravada (enviada ou não): nada é enviado; fica visível na API administrativa', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    h.sender.script(Result.err(permanent()));
    await flow(h, textJob(company.id), MORE).catch(() => undefined);
    assert.equal(h.sender.calls.length, 1);

    await h.processor.handleUnprocessedFailure(textJob(company.id));
    assert.equal(h.sender.calls.length, 1, 'sem texto padrão');
    assert.ok(h.logs.lines().some((entry) => String(entry.msg).includes('já há resposta gravada')));
  });

  it('job de aviso não envia nada; falha do envio do texto padrão e erro do banco só geram log, sem lançar', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.handleUnprocessedFailure(noticeJob(company.id));
    assert.equal(h.sender.calls.length, 0);

    h.sender.script(Result.err(permanent()));
    await h.processor.handleUnprocessedFailure(textJob(company.id));
    assert.equal(h.sender.calls.length, 1);

    const broken = setup({
      messages: { findByExternalId: () => Promise.reject(new DatabaseError('banco fora')) },
    });
    const other = await newCompany(broken, 'beta');
    await broken.processor.handleUnprocessedFailure(textJob(other.id));
    assert.equal(broken.sender.calls.length, 0);
    assert.ok(broken.logs.lines().some((entry) => Number(entry.level) >= 50));
    await h.processor.handleUnprocessedFailure(textJob('nao-e-uuid'));
  });

  it('número trocado desde o enfileiramento: nem o texto padrão sai; e nada vaza em log', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    const job = textJob(company.id);
    await h.companies.update(company.id, { whatsappPhoneNumberId: '555777' });
    await h.processor.handleUnprocessedFailure(job);
    assert.equal(h.sender.calls.length, 0);
    const raw = h.logs.raw();
    for (const secret of [SECRET_TEXT, CONTACT, WAMID, '555001', '555777']) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
  });
});

describe('ChannelInboundProcessor: empresa suspensa não recebe nada (decisão do dono, 2026-10-28)', () => {
  async function suspended(h: Harness, slug: string) {
    const company = await newCompany(h, slug, '555001');
    await h.companies.update(company.id, { status: 'SUSPENDED' });
    return company;
  }

  it('texto: o atendimento recusa a empresa suspensa e o job é descartado sem enviar NADA (nem o texto padrão), sem gravar mensagem', async () => {
    const h = setup();
    const company = await suspended(h, 'alfa');

    const outcome = await flow(h, textJob(company.id), LAST);

    assert.equal(outcome, 'discarded');
    assert.equal(h.sender.calls.length, 0);
    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.store.allMessages().length, 0);
    const line = h.logs.lines().find((entry) => String(entry.msg).includes('empresa suspensa'));
    assert.equal(line?.level, 40);
    assert.equal(line.companyId, company.id);
    assert.equal(typeof line.messageRef, 'string');
    const raw = h.logs.raw();
    for (const secret of [SECRET_TEXT, CONTACT, WAMID, '555001']) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
  });

  it('texto: ForbiddenError do atendimento (suspensão) também descarta, mesmo na última tentativa', async () => {
    const h = setup({
      attendance: { acceptInboundMessage: () => Promise.reject(new ForbiddenError('suspenso')) },
    });
    const company = await newCompany(h, 'alfa');
    assert.equal(await flow(h, textJob(company.id), LAST), 'discarded');
    assert.equal(await flow(h, textJob(company.id), MORE), 'discarded');
    assert.equal(h.sender.calls.length, 0);
  });

  it('aviso (notice) de empresa suspensa não é enviado: descartado', async () => {
    const h = setup();
    const company = await suspended(h, 'alfa');
    for (const reason of ['unsupported_type', 'invalid_text'] as const) {
      assert.equal(await h.processor.process(noticeJob(company.id, reason), MORE), 'discarded');
    }
    assert.equal(h.sender.calls.length, 0);
  });

  it('empresa suspensa depois que a resposta foi gravada: a retentativa descarta; a resposta fica gravada sem envio', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    h.sender.script(Result.err(retryable()));
    await flow(h, textJob(company.id), MORE).catch(() => undefined);
    await h.companies.update(company.id, { status: 'SUSPENDED' });

    assert.equal(await flow(h, textJob(company.id), MORE), 'discarded');
    assert.equal(h.sender.calls.length, 1, 'só a tentativa de antes da suspensão');
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
  });

  it('falha final sem handler (handleUnprocessedFailure): nem o texto padrão sai para empresa suspensa', async () => {
    const h = setup();
    const company = await suspended(h, 'alfa');
    await h.processor.handleUnprocessedFailure(textJob(company.id));
    await h.processor.handleUnprocessedFailure(noticeJob(company.id));
    assert.equal(h.sender.calls.length, 0);
    assert.ok(h.logs.lines().some((entry) => String(entry.msg).includes('empresa suspensa')));
  });

  it('empresa removida continua sem envio (permanente) e empresa ativa segue como antes', async () => {
    const h = setup();
    const removed = await newCompany(h, 'removido');
    await h.companies.delete(removed.id);
    await assert.rejects(
      h.processor.process(noticeJob(removed.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);

    const active = await newCompany(h, 'ativo', '555002');
    assert.equal(await h.processor.process(noticeJob(active.id), MORE), 'done');
    assert.equal(await flow(h, textJob(active.id), MORE), 'done');
    assert.equal(h.sender.calls.length, 2);
    assert.ok(h.sender.calls.every((call) => call.phoneNumberId === '555002'));
  });
});

describe('ChannelInboundProcessor: isolamento entre empresas', () => {
  it('o mesmo contato e o mesmo wamid em duas empresas: conversas, histórico, persona e número separados', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa', '111111');
    const b = await newCompany(h, 'beta', '222222');

    // Jobs intercalados das duas empresas, com o MESMO contato e o MESMO wamid.
    await flow(h, textJob(a.id, { text: 'primeira de A', externalId: 'wamid.mesmo' }), MORE);
    await flow(h, textJob(b.id, { text: 'primeira de B', externalId: 'wamid.mesmo' }), MORE);
    await flow(h, textJob(a.id, { text: 'segunda de A', externalId: 'wamid.dois' }), MORE);
    await flow(h, textJob(b.id, { text: 'segunda de B', externalId: 'wamid.dois' }), MORE);

    assert.equal(h.store.allConversations().length, 2);
    // Cada envio saiu pelo número da sua empresa.
    assert.deepEqual(
      h.sender.calls.map((call) => [
        call.phoneNumberId,
        call.text.includes(' A') || call.text.includes('de A'),
      ]),
      [
        ['111111', true],
        ['222222', false],
        ['111111', true],
        ['222222', false],
      ],
    );
    // O histórico enviado ao LLM nunca mistura empresas e a persona é a do dono da conversa.
    const secondOfA = h.llm.calls[2];
    const secondOfB = h.llm.calls[3];
    assert.ok(secondOfA !== undefined && secondOfB !== undefined);
    assert.deepEqual(
      secondOfA.history.map((turn) => turn.content).filter((text) => text.includes('B')),
      [],
    );
    assert.ok(secondOfA.history.some((turn) => turn.content.includes('primeira de A')));
    assert.ok(secondOfB.history.some((turn) => turn.content.includes('primeira de B')));
    assert.ok(secondOfA.systemPrompt.includes(`${PERSONA} alfa`));
    assert.ok(!secondOfA.systemPrompt.includes('beta'));
    assert.ok(secondOfB.systemPrompt.includes(`${PERSONA} beta`));
    assert.ok(!secondOfB.systemPrompt.includes('alfa'));
    // O mesmo wamid não colidiu: duas respostas por empresa, cada uma com a sua marca.
    assert.equal(
      h.store.allMessages().filter((m) => m.role === 'ASSISTANT' && m.sentAt !== null).length,
      4,
    );
  });

  it('jobs de duas empresas em sequência: cada linha de log do processador leva o companyId certo', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa', '1001');
    const b = await newCompany(h, 'beta', '1002');
    await flow(h, textJob(a.id, { externalId: 'wamid.a1' }), MORE);
    await flow(h, textJob(b.id, { externalId: 'wamid.b1' }), MORE);
    const sent = h.logs.lines().filter((entry) => entry.msg === 'resposta enviada ao contato');
    assert.deepEqual(
      sent.map((entry) => entry.companyId),
      [a.id, b.id],
    );
  });
});

describe('ChannelInboundProcessor: privacidade nos logs', () => {
  it('texto, contato, wamid, persona e número do envio não aparecem em nenhuma linha de log', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const h = setup();
    const company = await newCompany(h, 'alfa', '777888');

    // Sucesso, retentativa (já enviada), falha transitória, permanente, fallback, aviso e timeout.
    await flow(h, textJob(company.id), MORE);
    await flow(h, textJob(company.id), MORE);
    h.sender.script(Result.err(retryable()));
    await flow(h, textJob(company.id, { externalId: 'wamid.x2' }), MORE).catch(() => undefined);
    h.sender.script(Result.err(permanent(131047)));
    await flow(h, textJob(company.id, { externalId: 'wamid.x3' }), MORE).catch(() => undefined);
    await flow(
      h,
      textJob(company.id, { text: `${SECRET_TEXT} [[mock:fail]]`, externalId: 'wamid.x4' }),
      MORE,
    );
    await flow(
      h,
      textJob(company.id, { text: `${SECRET_TEXT} [[mock:hang]]`, externalId: 'wamid.x5' }),
      MORE,
    );
    await h.processor.process(noticeJob(company.id), MORE);
    h.sender.script(Result.err(permanent()));
    await h.processor.process(noticeJob(company.id), MORE).catch(() => undefined);

    // Falha do atendimento com envio do texto padrão (e falha dele).
    const failing = setup({
      attendance: { acceptInboundMessage: () => Promise.reject(new DatabaseError('banco fora')) },
    });
    const other = await newCompany(failing, 'beta', '777999');
    failing.sender.script(Result.err(permanent()));
    await flow(failing, textJob(other.id), LAST).catch(() => undefined);

    const everything = `${h.logs.raw()}${failing.logs.raw()}`;
    assert.ok(everything.length > 0);
    for (const secret of [
      SECRET_TEXT,
      CONTACT,
      WAMID,
      Buffer.from(`\u001c\u0018\u000b${CONTACT}`).toString('base64'),
      PERSONA,
      '777888',
    ]) {
      assert.ok(!everything.includes(secret), `vazou em log: ${secret}`);
    }
  });
});

describe('ChannelInboundProcessor: erro de serviço externo sem classificação', () => {
  it('um ExternalServiceError que não é MessageSendError é tratado como transitório', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const failure = new ExternalServiceError('falha genérica do canal');
    h.sender.script(Result.err(failure));
    await assert.rejects(flow(h, textJob(company.id), MORE), (e: unknown) => e === failure);
  });
});

describe('ChannelInboundProcessor: etapa aceitar e agendamento do flush (spec 013)', () => {
  it('o job text só grava e agenda: nada de LLM nem envio; o flush não leva texto e agenda a janela deslizante', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');

    assert.equal(await h.processor.process(textJob(company.id), MORE), 'done');

    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.sender.calls.length, 0);
    assert.equal(h.store.allMessages().length, 1);
    assert.equal(h.scheduler.calls.length, 1);
    const [call] = h.scheduler.calls;
    assert.deepEqual(call?.schedule, { delayMs: 5_000, mode: 'slide' });
    assert.deepEqual(Object.keys(call.job).sort(), [
      'companyId',
      'contactRef',
      'kind',
      'phoneNumberId',
      'requestId',
    ]);
    assert.ok(!JSON.stringify(call.job).includes(SECRET_TEXT), 'o job flush não contém texto');
    assert.equal(call.job.phoneNumberId, '555001');
  });

  it('o teto de espera encurta o atraso: nunca passa de maxWait desde a mais antiga pendente', async () => {
    // Relógio com 10 ms por leitura; teto curto força o corte depois de poucas mensagens.
    const h = setup({ batch: { windowMs: 5_000, maxWaitMs: 60 } });
    const company = await newCompany(h, 'alfa');
    for (let i = 0; i < 12; i += 1) {
      await h.processor.process(textJob(company.id, { externalId: `wamid.t${String(i)}` }), MORE);
    }
    const delays = h.scheduler.calls.map((call) => call.schedule.delayMs);
    assert.equal(delays[0], 60, 'a primeira espera no máximo o teto');
    assert.ok(delays.every((delay) => delay <= 60));
    assert.equal(delays.at(-1), 0, 'passado o teto, a resposta sai sem esperar');
  });

  it('janela zero agenda com atraso zero', async () => {
    const h = setup({ batch: { windowMs: 0 } });
    const company = await newCompany(h, 'alfa');
    await h.processor.process(textJob(company.id), MORE);
    assert.equal(h.scheduler.calls[0]?.schedule.delayMs, 0);
  });

  it('reentrega de mensagem pendente só garante o flush (ensure); de mensagem já respondida não grava nem agenda', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.process(textJob(company.id), MORE);
    await h.processor.process(textJob(company.id), MORE);
    assert.deepEqual(
      h.scheduler.calls.map((call) => call.schedule.mode),
      ['slide', 'ensure'],
    );
    assert.equal(h.store.allMessages().length, 1);

    await h.processor.process(flushOf(textJob(company.id)), MORE);
    h.scheduler.calls.length = 0;
    assert.equal(await h.processor.process(textJob(company.id), MORE), 'done');
    assert.equal(h.scheduler.calls.length, 0);
    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.sender.calls.length, 1);
  });

  it('o aviso (notice) segue imediato: nada é agendado e nada entra no lote', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.process(textJob(company.id), MORE);
    assert.equal(await h.processor.process(noticeJob(company.id), MORE), 'done');
    assert.equal(h.scheduler.calls.length, 1, 'só o agendamento do texto');
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]?.text, CHANNEL_NOTICE_TEXTS.unsupported_type);
    assert.equal(h.llm.calls.length, 0, 'o texto pendente continua esperando a janela');
  });

  it('falha ao agendar (Redis fora) é retentada e, na última tentativa, o contato recebe o texto padrão', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    h.scheduler.failWith = new ExternalServiceError('Redis fora');
    await assert.rejects(h.processor.process(textJob(company.id), MORE), ExternalServiceError);
    assert.equal(h.sender.calls.length, 0);
    await assert.rejects(h.processor.process(textJob(company.id), LAST), ExternalServiceError);
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]?.text, ATTENDANCE_FALLBACK_TEXT);
  });
});

describe('ChannelInboundProcessor: job flush (spec 013)', () => {
  const textOf = (h: Harness, companyId: string, text: string, id: string) =>
    h.processor.process(textJob(companyId, { text, externalId: id }), MORE);

  it('três mensagens, um flush: uma chamada ao LLM, uma resposta enviada, o lote inteiro respondido', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    await textOf(h, company.id, 'um', 'wamid.1');
    await textOf(h, company.id, 'dois', 'wamid.2');
    await textOf(h, company.id, 'tres', 'wamid.3');

    assert.equal(await h.processor.process(flushOf(textJob(company.id)), MORE), 'done');

    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.llm.calls[0]?.userMessage, 'um\ndois\ntres');
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]?.phoneNumberId, '555001');
    const contactMessages = h.store.allMessages().filter((message) => message.role === 'USER');
    assert.ok(contactMessages.every((user) => user.answeredById !== null));
    // Nada sobrou: nenhum agendamento além dos três do aceitar.
    assert.equal(h.scheduler.calls.length, 3);
  });

  it('sobrou pendente (limite do lote): agenda o próximo flush sem nova espera e o próximo responde o resto', async () => {
    const h = setup({ batch: { maxMessages: 2 } });
    const company = await newCompany(h, 'alfa');
    for (let i = 1; i <= 3; i += 1) {
      await textOf(h, company.id, `m${String(i)}`, `wamid.${String(i)}`);
    }
    h.scheduler.calls.length = 0;

    await h.processor.process(flushOf(textJob(company.id)), MORE);
    assert.equal(h.llm.calls[0]?.userMessage, 'm1\nm2');
    assert.deepEqual(
      h.scheduler.calls.map((call) => call.schedule),
      [{ delayMs: 0, mode: 'ensure' }],
    );

    await h.processor.process(flushOf(textJob(company.id)), MORE);
    assert.equal(h.llm.calls[1]?.userMessage, 'm3');
    assert.equal(h.scheduler.calls.length, 1, 'o último turno não agenda mais nada');
    assert.equal(h.sender.calls.length, 2);
  });

  it('flush repetido depois da resposta gravada e antes do sentAt só reenvia, sem novo LLM; depois do sentAt não envia', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await textOf(h, company.id, 'oi', 'wamid.1');
    h.sender.script(Result.err(permanent(131047)));
    await assert.rejects(
      h.processor.process(flushOf(textJob(company.id)), MORE),
      NonRetryableJobError,
    );
    assert.equal(h.llm.calls.length, 1);

    assert.equal(await h.processor.process(flushOf(textJob(company.id)), MORE), 'done');
    assert.equal(h.llm.calls.length, 1, 'sem nova chamada ao LLM');
    assert.equal(h.sender.calls.length, 2);
    assert.equal(h.sender.calls[1]?.text, h.sender.calls[0]?.text);

    assert.equal(await h.processor.process(flushOf(textJob(company.id)), MORE), 'done');
    assert.equal(h.sender.calls.length, 2, 'depois do sentAt não envia de novo');
  });

  it('falha do LLM no lote: um fallback marca todas e é enviado uma vez', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await textOf(h, company.id, 'um', 'wamid.1');
    await textOf(h, company.id, 'dois [[mock:fail]]', 'wamid.2');

    await h.processor.process(flushOf(textJob(company.id)), MORE);

    assert.deepEqual(
      h.sender.calls.map((call) => call.text),
      [ATTENDANCE_FALLBACK_TEXT],
    );
    const stored = h.store.allMessages();
    assert.equal(stored.filter((message) => message.isFallback).length, 1);
    assert.ok(stored.filter((m) => m.role === 'USER').every((m) => m.answeredById !== null));
  });

  it('erro transitório no envio é retentado: a retentativa reenvia a MESMA resposta antes de responder o excedente, sem novo LLM', async () => {
    const h = setup({ batch: { maxMessages: 1 } });
    const company = await newCompany(h, 'alfa');
    await textOf(h, company.id, 'a', 'wamid.1');
    await textOf(h, company.id, 'b', 'wamid.2');
    const failure = retryable();
    h.sender.script(Result.err(failure));

    await assert.rejects(
      h.processor.process(flushOf(textJob(company.id)), { attempt: 1, finalAttempt: false }),
      (error: unknown) => error === failure,
    );
    assert.equal(h.llm.calls.length, 1);

    // Retentativa: reenvia a resposta de `a` (não responde `b` ainda) e agenda o próximo turno.
    h.scheduler.calls.length = 0;
    await h.processor.process(flushOf(textJob(company.id)), { attempt: 2, finalAttempt: false });
    assert.equal(h.llm.calls.length, 1, 'sem nova chamada ao LLM');
    assert.equal(h.sender.calls.length, 2);
    assert.equal(h.sender.calls[1]?.text, h.sender.calls[0]?.text);
    assert.deepEqual(
      h.scheduler.calls.map((call) => call.schedule.mode),
      ['ensure'],
    );
  });

  it('erro permanente no envio com excedente: o próximo turno é agendado mesmo assim', async () => {
    const h = setup({ batch: { maxMessages: 1 } });
    const company = await newCompany(h, 'alfa');
    await textOf(h, company.id, 'a', 'wamid.1');
    await textOf(h, company.id, 'b', 'wamid.2');
    h.scheduler.calls.length = 0;
    h.sender.script(Result.err(permanent(131047)));

    await assert.rejects(
      h.processor.process(flushOf(textJob(company.id)), MORE),
      NonRetryableJobError,
    );

    assert.equal(h.scheduler.calls.length, 1);
  });

  it('nada pendente: não faz nada', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    assert.equal(await h.processor.process(flushOf(textJob(company.id)), MORE), 'done');
    assert.equal(h.sender.calls.length, 0);
    assert.equal(h.llm.calls.length, 0);
  });

  it('empresa suspensa: o flush é descartado sem enviar nada; removido e número trocado descartam sem envio', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    await textOf(h, company.id, 'oi', 'wamid.1');
    const flush = flushOf(textJob(company.id));

    await h.companies.update(company.id, { status: 'SUSPENDED' });
    assert.equal(await h.processor.process(flush, LAST), 'discarded');
    assert.equal(h.sender.calls.length, 0);
    assert.equal(h.llm.calls.length, 0);

    await h.companies.update(company.id, { status: 'ACTIVE', whatsappPhoneNumberId: '555777' });
    await assert.rejects(h.processor.process(flush, MORE), NonRetryableJobError);
    assert.equal(h.sender.calls.length, 0);

    const removed = await newCompany(h, 'beta', '555002');
    await textOf(h, removed.id, 'oi', 'wamid.9');
    const removedFlush = flushOf(textJob(removed.id));
    await h.companies.delete(removed.id);
    await assert.rejects(h.processor.process(removedFlush, MORE), NonRetryableJobError);
    assert.equal(h.sender.calls.length, 0);
  });

  it('falha do atendimento na última tentativa do flush: texto padrão ao contato; nas anteriores, nada', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: { respondToPending: () => Promise.reject(error) } });
    const company = await newCompany(h, 'alfa', '555009');
    const flush = flushOf(textJob(company.id));
    await assert.rejects(h.processor.process(flush, MORE), (e: unknown) => e === error);
    assert.equal(h.sender.calls.length, 0);
    await assert.rejects(h.processor.process(flush, LAST), (e: unknown) => e === error);
    assert.deepEqual(h.sender.calls, [
      {
        phoneNumberId: '555009',
        accessToken: new SecretString(h.credentials.tokenOf(company.id)),
        to: CONTACT,
        text: ATTENDANCE_FALLBACK_TEXT,
      },
    ]);
  });

  it('flush que falhou sem handler: texto padrão só se há pendente', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.processor.handleUnprocessedFailure(flushOf(textJob(company.id)));
    assert.equal(h.sender.calls.length, 0, 'nada pendente');
    await textOf(h, company.id, 'oi', 'wamid.1');
    await h.processor.handleUnprocessedFailure(flushOf(textJob(company.id)));
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]?.text, ATTENDANCE_FALLBACK_TEXT);
  });

  it('isolamento: o mesmo contato em duas empresas tem lotes, números e chave do flush separados', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa', '111111');
    const b = await newCompany(h, 'beta', '222222');
    await textOf(h, a.id, 'a1', 'wamid.a1');
    await textOf(h, b.id, 'b1', 'wamid.b1');
    await textOf(h, a.id, 'a2', 'wamid.a2');

    await h.processor.process(flushOf(textJob(a.id)), MORE);
    await h.processor.process(flushOf(textJob(b.id)), MORE);

    assert.deepEqual(
      h.llm.calls.map((call) => call.userMessage),
      ['a1\na2', 'b1'],
    );
    assert.deepEqual(
      h.sender.calls.map((call) => call.phoneNumberId),
      ['111111', '222222'],
    );
    const first = h.scheduler.calls[0];
    const second = h.scheduler.calls[1];
    assert.ok(first !== undefined && second !== undefined);
    const keyA = flushKey(first.job);
    const keyB = flushKey(second.job);
    assert.ok(keyA.includes(a.id) && keyB.includes(b.id));
    assert.notEqual(keyA, keyB, 'o mesmo contato em duas empresas não colide');
    assert.ok(!keyA.includes(CONTACT), 'o telefone não aparece na chave');
  });

  it('privacidade: texto, contato e persona não aparecem em log em todo o fluxo; o log leva companyId', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '777888');
    await textOf(h, company.id, SECRET_TEXT, 'wamid.1');
    await textOf(h, company.id, `${SECRET_TEXT} [[mock:fail]]`, 'wamid.2');
    h.sender.script(Result.err(permanent(131047)));
    await h.processor.process(flushOf(textJob(company.id)), MORE).catch(() => undefined);
    await h.processor.process(flushOf(textJob(company.id)), MORE);

    const raw = h.logs.raw();
    for (const secret of [SECRET_TEXT, CONTACT, WAMID, PERSONA, '777888']) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
    const lines = h.logs.lines().filter((entry) => entry.msg === 'resposta enviada ao contato');
    assert.ok(lines.every((entry) => entry.companyId === company.id));
    assert.ok(lines.length >= 1);
  });
});

describe('ChannelInboundProcessor: credencial por empresa (spec 015)', () => {
  it('cada empresa envia com o token e o número dele, mesmo com mensagens dos dois seguidas', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa', '555001');
    const b = await newCompany(h, 'beta', '555002');

    await flow(h, textJob(a.id, { externalId: 'wamid.A' }), MORE);
    await flow(h, textJob(b.id, { externalId: 'wamid.B' }), MORE);

    assert.equal(h.sender.calls.length, 2);
    const [first, second] = h.sender.calls;
    assert.equal(first?.phoneNumberId, '555001');
    assert.equal(first.accessToken.reveal(), h.credentials.tokenOf(a.id));
    assert.equal(second?.phoneNumberId, '555002');
    assert.equal(second.accessToken.reveal(), h.credentials.tokenOf(b.id));
  });

  it('190 marca TOKEN_INVALID (com a versão), é permanente e não tenta o texto padrão', async () => {
    const h = setup();
    h.credentials.tokenVersion = 3;
    const company = await newCompany(h, 'alfa', '555001');
    h.sender.script(Result.err(permanent(190)));

    await assert.rejects(
      flow(h, textJob(company.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );

    assert.deepEqual(h.credentials.marks, [{ companyId: company.id, tokenVersion: 3 }]);
    assert.equal(h.sender.calls.length, 1, 'sem texto padrão: o token é o mesmo');
    assert.ok(!h.logs.raw().includes(h.credentials.tokenOf(company.id)));
  });

  it('o flush seguinte de uma empresa TOKEN_INVALID é descartado sem LLM e sem envio; o outra empresa segue', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa', '555001');
    const b = await newCompany(h, 'beta', '555002');
    h.credentials.invalid.add(a.id);

    await h.processor.process(textJob(a.id), MORE);
    assert.equal(await h.processor.process(flushOf(textJob(a.id)), MORE), 'discarded');
    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.sender.calls.length, 0);

    assert.equal(await flow(h, textJob(b.id, { externalId: 'wamid.B' }), MORE), 'done');
    assert.equal(h.sender.calls[0]?.phoneNumberId, '555002');

    // As mensagens de A seguem pendentes: depois de reconectar, o próximo flush as responde.
    h.credentials.invalid.delete(a.id);
    assert.equal(await h.processor.process(flushOf(textJob(a.id)), MORE), 'done');
    assert.equal(h.llm.calls.length, 2);
  });

  it('aviso para empresa TOKEN_INVALID é descartado sem enviar', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    h.credentials.invalid.add(company.id);
    assert.equal(await h.processor.process(noticeJob(company.id), MORE), 'discarded');
    assert.equal(h.sender.calls.length, 0);
  });

  it('outro código permanente (janela de 24 h) não muda o estado', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    h.sender.script(Result.err(permanent(131047)));
    await assert.rejects(
      flow(h, textJob(company.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    assert.deepEqual(h.credentials.marks, []);
  });

  it('texto cifrado que não decifra: permanente, sem envio e sem marcar TOKEN_INVALID', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '555001');
    const failure = new CredentialDecryptionError('tampered');
    const original = h.credentials.forCompany.bind(h.credentials);
    let broken = false;
    h.credentials.forCompany = (id) => (broken ? Promise.reject(failure) : original(id));
    await h.processor.process(textJob(company.id), MORE);
    broken = true;
    await assert.rejects(
      h.processor.process(flushOf(textJob(company.id)), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
    assert.deepEqual(h.credentials.marks, []);
  });
});
