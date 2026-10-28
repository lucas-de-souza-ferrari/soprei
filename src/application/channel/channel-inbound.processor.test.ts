import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConflictError,
  DatabaseError,
  ExternalServiceError,
  ForbiddenError,
} from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { ATTENDANCE_FALLBACK_TEXT, AttendanceService } from '../attendance/attendance.service.js';
import type { InboundJob } from '../ports/inbound-job-queue.js';
import { NonRetryableJobError } from '../ports/inbound-job-queue.js';
import {
  MessageSendError,
  type MessageSender,
  type SendTextInput,
} from '../ports/message-sender.js';
import { CHANNEL_NOTICE_TEXTS } from './channel-texts.js';
import { ChannelInboundProcessor } from './channel-inbound.processor.js';

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
  readonly clients: InMemoryClientRepository;
  readonly store: InMemoryAttendanceStore;
  readonly llm: MockLlmProvider;
  readonly sender: FakeSender;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly processor: ChannelInboundProcessor;
  readonly service: AttendanceService;
  advance(ms: number): void;
}

function setup(
  overrides: {
    attendance?: { handleInboundMessage: AttendanceService['handleInboundMessage'] };
    messages?: { markSent: InMemoryAttendanceStore['messages']['markSent'] };
  } = {},
): Harness {
  let time = Date.UTC(2026, 0, 1);
  const now = (): Date => new Date((time += 1));
  const clients = new InMemoryClientRepository();
  const store = new InMemoryAttendanceStore(now);
  const llm = new MockLlmProvider({ recordCalls: true });
  const logs = captureLogs();
  const service = new AttendanceService({
    clients,
    conversations: store.conversations,
    messages: store.messages,
    unitOfWork: store,
    llm,
    logger: logs.logger,
    options: { llmTimeoutMs: 300, inFlightTimeoutMs: IN_FLIGHT_MS, now },
  });
  const sender = new FakeSender();
  const processor = new ChannelInboundProcessor({
    attendance: overrides.attendance ?? service,
    clients,
    messages: overrides.messages ?? store.messages,
    sender,
    logger: logs.logger,
    now,
  });
  return {
    clients,
    store,
    llm,
    sender,
    logs,
    processor,
    service,
    advance(ms) {
      time += ms;
    },
  };
}

/** Número do negócio com que cada cliente foi criado: o `phoneNumberId` que o job leva ao ser enfileirado. */
const jobPhone = new Map<string, string>();

async function newClient(h: Harness, slug: string, phoneNumberId: string | null = '1000') {
  const created = await h.clients.create({ name: `Empresa ${slug}`, slug });
  jobPhone.set(created.id, phoneNumberId ?? '1000');
  return h.clients.update(created.id, {
    persona: `${PERSONA} ${slug}`,
    whatsappPhoneNumberId: phoneNumberId,
  });
}

const textJob = (
  clientId: string,
  overrides: Partial<Extract<InboundJob, { kind: 'text' }>> = {},
): Extract<InboundJob, { kind: 'text' }> => ({
  kind: 'text',
  clientId,
  phoneNumberId: jobPhone.get(clientId) ?? '1000',
  contactRef: CONTACT,
  text: SECRET_TEXT,
  externalId: WAMID,
  requestId: 'req-12345678',
  ...overrides,
});

const noticeJob = (
  clientId: string,
  reason: 'unsupported_type' | 'invalid_text' = 'unsupported_type',
): InboundJob => ({
  kind: 'notice',
  clientId,
  phoneNumberId: jobPhone.get(clientId) ?? '1000',
  contactRef: CONTACT,
  externalId: WAMID,
  requestId: 'req-12345678',
  reason,
});

const LAST: { finalAttempt: boolean } = { finalAttempt: true };
const MORE: { finalAttempt: boolean } = { finalAttempt: false };

describe('ChannelInboundProcessor: job de texto', () => {
  it('atende, envia a resposta pelo número do cliente no banco e grava a marca de envio', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '555001');

    const outcome = await h.processor.process(textJob(client.id), MORE);

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
    const client = await newClient(h, 'alfa');

    await h.processor.process(textJob(client.id), MORE);
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.llm.calls.length, 1);

    const again = await h.processor.process(textJob(client.id), MORE);
    assert.equal(again, 'done');
    assert.equal(h.sender.calls.length, 1, 'não reenvia');
    assert.equal(h.llm.calls.length, 1, 'não chama o LLM de novo');
    assert.equal(h.store.allMessages().length, 2, 'uma só resposta gravada');
  });

  it('o número do envio é o do banco: campos extras de um job adulterado (número, destinatário) são ignorados', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '555001');
    const forged = {
      ...textJob(client.id),
      phone_number_id: '999999',
      sendFrom: '999999',
      to: '5500000000000',
    } as unknown as InboundJob;

    await h.processor.process(forged, MORE);

    assert.equal(h.sender.calls[0]?.phoneNumberId, '555001');
    assert.equal(h.sender.calls[0].to, CONTACT);
  });

  it('job cujo phoneNumberId não é o do cliente no banco (adulterado): erro permanente, nada é enviado, log sem conteúdo', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '555001');
    const other = await newClient(h, 'beta', '555002');

    for (const job of [textJob(client.id, { phoneNumberId: '555002' }), noticeJob(client.id)]) {
      const forged = { ...job, phoneNumberId: other.whatsappPhoneNumberId ?? '' };
      await assert.rejects(
        h.processor.process(forged, MORE),
        (error: unknown) => error instanceof NonRetryableJobError,
      );
    }
    assert.equal(
      h.sender.calls.length,
      0,
      'nada sai, nem pelo número do job nem pelo do outro cliente',
    );
    const line = h.logs
      .lines()
      .find((entry) => String(entry.msg).includes('o número do cliente mudou'));
    assert.equal(line?.level, 50);
    assert.equal(line.clientId, client.id);
    const raw = h.logs.raw();
    for (const secret of ['555001', '555002', CONTACT, SECRET_TEXT, WAMID]) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
  });

  it('número trocado entre enfileirar e processar: texto e aviso não enviam (nem o texto padrão)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '555001');
    const text = textJob(client.id);
    const notice = noticeJob(client.id);
    // O dono troca o número do cliente depois de a mensagem entrar na fila.
    await h.clients.update(client.id, { whatsappPhoneNumberId: '555777' });

    await assert.rejects(
      h.processor.process(text, MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    await assert.rejects(
      h.processor.process(notice, MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
    // A resposta ficou gravada sem envio (visível na API administrativa).
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
  });

  it('cliente sem número no banco: descarta com log, sem enviar; a resposta fica gravada sem envio', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', null);

    const outcome = await h.processor.process(textJob(client.id), MORE);

    assert.equal(outcome, 'discarded');
    assert.equal(h.sender.calls.length, 0);
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
    const line = h.logs.lines().find((entry) => String(entry.msg).includes('sem número'));
    assert.equal(line?.clientId, client.id);
  });

  it('clientId malformado no job é erro permanente', async () => {
    const h = setup();
    await assert.rejects(
      h.processor.process(textJob('nao-e-uuid'), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
  });

  it('LLM com falha e com timeout: o fallback é gravado E enviado', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    for (const marker of ['[[mock:fail]]', '[[mock:hang]]']) {
      const h = setup();
      const client = await newClient(h, 'alfa');
      await h.processor.process(textJob(client.id, { text: `oi ${marker}` }), MORE);
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
    const client = await newClient(h, 'alfa');
    const failure = retryable();
    h.sender.script(Result.err(failure));

    await assert.rejects(h.processor.process(textJob(client.id), MORE), (error: unknown) => {
      return error === failure;
    });
    assert.equal(h.sender.calls.length, 1, 'só a tentativa da resposta, sem fallback');
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);

    // A retentativa envia a MESMA resposta (sem novo LLM) e confirma o envio.
    const outcome = await h.processor.process(textJob(client.id), MORE);
    assert.equal(outcome, 'done');
    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.sender.calls.length, 2);
    assert.equal(h.sender.calls[1]?.text, h.sender.calls[0]?.text);
    assert.equal(h.store.allMessages().length, 2);
    assert.ok(h.store.allMessages().find((m) => m.role === 'ASSISTANT')?.sentAt instanceof Date);
  });

  it('falha permanente: NonRetryableJobError, sem fallback, resposta sem envio, log error com clientId e código', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    h.sender.script(Result.err(permanent(131047)));

    await assert.rejects(
      h.processor.process(textJob(client.id), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 1, 'sem fallback quando a resposta já existe');
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.equal(reply?.sentAt, null);
    const line = h.logs.lines().find((entry) => String(entry.msg).includes('envio recusado'));
    assert.equal(line?.level, 50);
    assert.equal(line.clientId, client.id);
    assert.equal(line.providerCode, 131047);
    assert.equal(typeof line.messageRef, 'string');
  });

  it('falha transitória na última tentativa também não manda fallback (a resposta existe)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    h.sender.script(Result.err(retryable()));
    await assert.rejects(h.processor.process(textJob(client.id), LAST));
    assert.equal(h.sender.calls.length, 1);
  });

  it('a falha ao gravar a marca de envio só gera log error: o contato já recebeu, nada é relançado', async () => {
    const failingMark = setup({
      messages: {
        markSent: () => Promise.reject(new DatabaseError('banco caiu na marca')),
      },
    });
    const client = await newClient(failingMark, 'alfa');
    const outcome = await failingMark.processor.process(textJob(client.id), MORE);
    assert.equal(outcome, 'done');
    assert.equal(failingMark.sender.calls.length, 1);
    const line = failingMark.logs
      .lines()
      .find((entry) => String(entry.msg).includes('marca de envio'));
    assert.equal(line?.level, 50);
    assert.equal(line.clientId, client.id);
  });
});

describe('ChannelInboundProcessor: falha do atendimento antes de existir resposta', () => {
  const failing = (
    error: Error,
  ): { handleInboundMessage: AttendanceService['handleInboundMessage'] } => ({
    handleInboundMessage: () => Promise.reject(error),
  });

  it('transitória com tentativas restantes: relança sem enviar nada', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: failing(error) });
    const client = await newClient(h, 'alfa');
    await assert.rejects(
      h.processor.process(textJob(client.id), MORE),
      (e: unknown) => e === error,
    );
    assert.equal(h.sender.calls.length, 0);
  });

  it('na última tentativa: envia o texto padrão ao contato e relança o erro', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: failing(error) });
    const client = await newClient(h, 'alfa', '555009');
    await assert.rejects(
      h.processor.process(textJob(client.id), LAST),
      (e: unknown) => e === error,
    );
    assert.equal(h.sender.calls.length, 1);
    assert.deepEqual(h.sender.calls[0], {
      phoneNumberId: '555009',
      to: CONTACT,
      text: ATTENDANCE_FALLBACK_TEXT,
    });
  });

  it('se o envio do texto padrão também falha, só loga (o erro original segue)', async () => {
    const error = new DatabaseError('indisponível');
    const h = setup({ attendance: failing(error) });
    const client = await newClient(h, 'alfa');
    h.sender.script(Result.err(permanent()));
    await assert.rejects(
      h.processor.process(textJob(client.id), LAST),
      (e: unknown) => e === error,
    );
    assert.equal(h.sender.calls.length, 1, 'uma única tentativa');
    const warn = h.logs
      .lines()
      .find((entry) => String(entry.msg).includes('texto padrão ao contato'));
    assert.ok(warn !== undefined);
  });

  it('erro permanente (cliente suspenso, removido, entrada inválida): sem retentativa, com o texto padrão', async () => {
    for (const error of [new ForbiddenError('suspenso')]) {
      const h = setup({ attendance: failing(error) });
      const client = await newClient(h, 'alfa');
      await assert.rejects(
        h.processor.process(textJob(client.id), MORE),
        (e: unknown) => e instanceof NonRetryableJobError,
      );
      assert.equal(h.sender.calls.length, 1);
      assert.equal(h.sender.calls[0]?.text, ATTENDANCE_FALLBACK_TEXT);
    }
  });

  it('cliente removido depois de enfileirar: permanente, e sem número não há por onde responder', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await h.clients.delete(client.id);
    await assert.rejects(
      h.processor.process(textJob(client.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    assert.equal(h.sender.calls.length, 0);
  });

  it('ConflictError (mensagem em andamento) é retentado; passado o prazo, completa sem segunda chamada ao LLM', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    const conversation = await h.store.conversations.findOrCreateByContact(client.id, CONTACT);
    await h.store.messages.create(client.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: SECRET_TEXT,
      externalId: WAMID,
    });

    // Mensagem ainda viva (sem resposta e recente): 409 retentável, sem LLM nem envio.
    await assert.rejects(
      h.processor.process(textJob(client.id), MORE),
      (error: unknown) => error instanceof ConflictError,
    );
    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.sender.calls.length, 0);

    h.advance(IN_FLIGHT_MS + 1);
    const outcome = await h.processor.process(textJob(client.id), MORE);
    assert.equal(outcome, 'done');
    assert.equal(h.llm.calls.length, 1, 'uma só chamada ao LLM para a mensagem');
    assert.equal(h.sender.calls.length, 1);
  });
});

describe('ChannelInboundProcessor: job de aviso', () => {
  it('envia o texto constante pelo número do cliente, sem gravar mensagem nem chamar o LLM', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '555001');

    for (const reason of ['unsupported_type', 'invalid_text'] as const) {
      assert.equal(await h.processor.process(noticeJob(client.id, reason), MORE), 'done');
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
    const client = await newClient(h, 'alfa');
    const failure = retryable();
    h.sender.script(Result.err(failure), Result.err(permanent()));
    await assert.rejects(
      h.processor.process(noticeJob(client.id), MORE),
      (e: unknown) => e === failure,
    );
    await assert.rejects(
      h.processor.process(noticeJob(client.id), MORE),
      (e: unknown) => e instanceof NonRetryableJobError,
    );
    // Aviso nunca dispara o texto padrão (não há atendimento).
    assert.equal(h.sender.calls.length, 2);

    const noNumber = await newClient(h, 'beta', null);
    assert.equal(await h.processor.process(noticeJob(noNumber.id), MORE), 'discarded');
    assert.equal(h.sender.calls.length, 2);
  });
});

describe('ChannelInboundProcessor: isolamento entre clientes', () => {
  it('o mesmo contato e o mesmo wamid em dois clientes: conversas, histórico, persona e número separados', async () => {
    const h = setup();
    const a = await newClient(h, 'alfa', '111111');
    const b = await newClient(h, 'beta', '222222');

    // Jobs intercalados dos dois clientes, com o MESMO contato e o MESMO wamid.
    await h.processor.process(
      textJob(a.id, { text: 'primeira de A', externalId: 'wamid.mesmo' }),
      MORE,
    );
    await h.processor.process(
      textJob(b.id, { text: 'primeira de B', externalId: 'wamid.mesmo' }),
      MORE,
    );
    await h.processor.process(
      textJob(a.id, { text: 'segunda de A', externalId: 'wamid.dois' }),
      MORE,
    );
    await h.processor.process(
      textJob(b.id, { text: 'segunda de B', externalId: 'wamid.dois' }),
      MORE,
    );

    assert.equal(h.store.allConversations().length, 2);
    // Cada envio saiu pelo número do seu cliente.
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
    // O histórico enviado ao LLM nunca mistura clientes e a persona é a do dono da conversa.
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
    // O mesmo wamid não colidiu: duas respostas por cliente, cada uma com a sua marca.
    assert.equal(
      h.store.allMessages().filter((m) => m.role === 'ASSISTANT' && m.sentAt !== null).length,
      4,
    );
  });

  it('jobs de dois clientes em sequência: cada linha de log do processador leva o clientId certo', async () => {
    const h = setup();
    const a = await newClient(h, 'alfa', '1001');
    const b = await newClient(h, 'beta', '1002');
    await h.processor.process(textJob(a.id, { externalId: 'wamid.a1' }), MORE);
    await h.processor.process(textJob(b.id, { externalId: 'wamid.b1' }), MORE);
    const sent = h.logs.lines().filter((entry) => entry.msg === 'resposta enviada ao contato');
    assert.deepEqual(
      sent.map((entry) => entry.clientId),
      [a.id, b.id],
    );
  });
});

describe('ChannelInboundProcessor: privacidade nos logs', () => {
  it('texto, contato, wamid, persona e número do envio não aparecem em nenhuma linha de log', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const h = setup();
    const client = await newClient(h, 'alfa', '777888');

    // Sucesso, retentativa (já enviada), falha transitória, permanente, fallback, aviso e timeout.
    await h.processor.process(textJob(client.id), MORE);
    await h.processor.process(textJob(client.id), MORE);
    h.sender.script(Result.err(retryable()));
    await h.processor
      .process(textJob(client.id, { externalId: 'wamid.x2' }), MORE)
      .catch(() => undefined);
    h.sender.script(Result.err(permanent(131047)));
    await h.processor
      .process(textJob(client.id, { externalId: 'wamid.x3' }), MORE)
      .catch(() => undefined);
    await h.processor.process(
      textJob(client.id, { text: `${SECRET_TEXT} [[mock:fail]]`, externalId: 'wamid.x4' }),
      MORE,
    );
    await h.processor.process(
      textJob(client.id, { text: `${SECRET_TEXT} [[mock:hang]]`, externalId: 'wamid.x5' }),
      MORE,
    );
    await h.processor.process(noticeJob(client.id), MORE);
    h.sender.script(Result.err(permanent()));
    await h.processor.process(noticeJob(client.id), MORE).catch(() => undefined);

    // Falha do atendimento com envio do texto padrão (e falha dele).
    const failing = setup({
      attendance: { handleInboundMessage: () => Promise.reject(new DatabaseError('banco fora')) },
    });
    const other = await newClient(failing, 'beta', '777999');
    failing.sender.script(Result.err(permanent()));
    await failing.processor.process(textJob(other.id), LAST).catch(() => undefined);

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
    const client = await newClient(h, 'alfa');
    const failure = new ExternalServiceError('falha genérica do canal');
    h.sender.script(Result.err(failure));
    await assert.rejects(
      h.processor.process(textJob(client.id), MORE),
      (e: unknown) => e === failure,
    );
  });
});
