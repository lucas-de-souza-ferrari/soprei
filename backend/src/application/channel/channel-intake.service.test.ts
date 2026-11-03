import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '../../domain/index.js';
import { DatabaseError, ExternalServiceError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { type InboundJob, type InboundJobQueue, inboundJobId } from '../ports/inbound-job-queue.js';
import {
  type ChannelInboundResult,
  ChannelIntakeService,
  contentFromType,
  type InboundChannelMessage,
} from './channel-intake.service.js';

const SECRET_TEXT = 'texto-secreto-do-contato-4c1';
const CONTACT = '5511987654321';
const WAMID = `wamid.${Buffer.from(`\u001c\u0018\u000b${CONTACT}`).toString('base64')}`;

/** Fila de mentira com o dedupe por `jobId` do BullMQ (o mesmo id não entra duas vezes). */
class FakeQueue implements Pick<InboundJobQueue, 'enqueue'> {
  readonly jobs = new Map<string, InboundJob>();
  failOn: ((job: InboundJob) => boolean) | undefined;
  attempts = 0;

  enqueue(job: InboundJob): Promise<Result<void, ExternalServiceError>> {
    this.attempts += 1;
    if (this.failOn?.(job) === true) {
      return Promise.resolve(Result.err(new ExternalServiceError('fila fora')));
    }
    const id = inboundJobId(job);
    if (!this.jobs.has(id)) this.jobs.set(id, job);
    return Promise.resolve(Result.ok(undefined));
  }

  all(): InboundJob[] {
    return [...this.jobs.values()];
  }
}

interface Harness {
  readonly clients: InMemoryClientRepository;
  readonly queue: FakeQueue;
  readonly results: ChannelInboundResult[];
  readonly logs: ReturnType<typeof captureLogs>;
  readonly intake: ChannelIntakeService;
  lookups: number;
}

function setup(
  clientsOverride?: Pick<InMemoryClientRepository, 'findByWhatsappPhoneNumberId'>,
): Harness {
  const clients = new InMemoryClientRepository();
  const queue = new FakeQueue();
  const results: ChannelInboundResult[] = [];
  const logs = captureLogs();
  const harness = { lookups: 0 };
  const lookup = clientsOverride ?? clients;
  const intake = new ChannelIntakeService({
    clients: {
      findByWhatsappPhoneNumberId: (id) => {
        harness.lookups += 1;
        return lookup.findByWhatsappPhoneNumberId(id);
      },
    },
    queue,
    logger: logs.logger,
    metrics: {
      countChannelInbound: (_channel, result) => {
        results.push(result);
      },
    },
    channel: 'whatsapp',
  });
  return Object.assign(harness, { clients, queue, results, logs, intake });
}

async function newClient(
  h: Pick<Harness, 'clients'>,
  slug: string,
  phoneNumberId: string | null,
  status: Client['status'] = 'ACTIVE',
): Promise<Client> {
  const created = await h.clients.create({ name: `Empresa ${slug}`, slug, status });
  return phoneNumberId === null
    ? created
    : h.clients.update(created.id, { whatsappPhoneNumberId: phoneNumberId });
}

/** `body` e `sender` ausentes valem o padrão; `undefined` explícito vale "o canal não informou". */
const text = (
  phoneNumberId: string,
  messageId: string,
  fields: { body?: string | undefined; sender?: string | undefined } = {},
): InboundChannelMessage => ({
  phoneNumberId,
  messageId,
  sender: 'sender' in fields ? fields.sender : CONTACT,
  content: { kind: 'text', text: 'body' in fields ? fields.body : SECRET_TEXT },
});

const unsupported = (phoneNumberId: string, messageId: string): InboundChannelMessage => ({
  phoneNumberId,
  messageId,
  sender: CONTACT,
  content: { kind: 'unsupported' },
});

describe('ChannelIntakeService: roteamento', () => {
  it('texto de número mapeado vira job text com contactRef = remetente, externalId = wamid e o clientId do dono', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '1001');

    const summary = await h.intake.accept([text('1001', WAMID)], 'req-12345678');

    assert.deepEqual(summary, { enqueued: 1, discarded: 0, failed: 0 });
    assert.deepEqual(h.queue.all(), [
      {
        kind: 'text',
        clientId: client.id,
        phoneNumberId: '1001',
        contactRef: CONTACT,
        text: SECRET_TEXT,
        externalId: WAMID,
        requestId: 'req-12345678',
      },
    ]);
    assert.deepEqual(h.results, ['enqueued']);
  });

  it('lote com vários números e vários clientes: cada mensagem vai para o cliente certo, na ordem', async () => {
    const h = setup();
    const a = await newClient(h, 'alfa', '1001');
    const b = await newClient(h, 'beta', '1002');

    const summary = await h.intake.accept(
      [
        text('1001', 'wamid.1'),
        text('1002', 'wamid.2'),
        text('1001', 'wamid.3'),
        unsupported('1002', 'wamid.4'),
      ],
      'req-12345678',
    );

    assert.deepEqual(summary, { enqueued: 4, discarded: 0, failed: 0 });
    assert.deepEqual(
      h.queue.all().map((job) => [job.clientId, job.externalId, job.kind]),
      [
        [a.id, 'wamid.1', 'text'],
        [b.id, 'wamid.2', 'text'],
        [a.id, 'wamid.3', 'text'],
        [b.id, 'wamid.4', 'notice'],
      ],
    );
    // Uma resolução por número no lote, não uma por mensagem.
    assert.equal(h.lookups, 2);
  });

  it('o mesmo wamid em clientes diferentes não colide: dois jobs, cada um do seu cliente', async () => {
    const h = setup();
    const a = await newClient(h, 'alfa', '1001');
    const b = await newClient(h, 'beta', '1002');
    await h.intake.accept(
      [text('1001', 'wamid.mesmo'), text('1002', 'wamid.mesmo')],
      'req-12345678',
    );
    assert.equal(h.queue.jobs.size, 2);
    assert.deepEqual(new Set(h.queue.all().map((job) => job.clientId)), new Set([a.id, b.id]));
    assert.notEqual(
      inboundJobId({ clientId: a.id, externalId: 'wamid.mesmo' }),
      inboundJobId({ clientId: b.id, externalId: 'wamid.mesmo' }),
    );
  });

  it('reentrega do mesmo evento não gera segundo job', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    await h.intake.accept([text('1001', 'wamid.1')], 'req-aaaaaaaa');
    await h.intake.accept([text('1001', 'wamid.1')], 'req-bbbbbbbb');
    assert.equal(h.queue.jobs.size, 1);
  });

  it('número desconhecido, cliente removido e cliente suspenso: nada enfileirado, métrica e log warn', async () => {
    const h = setup();
    await newClient(h, 'suspenso', '1003', 'SUSPENDED');
    const removed = await newClient(h, 'removido', '1004');
    await h.clients.delete(removed.id);

    const summary = await h.intake.accept(
      [text('9999', 'wamid.1'), text('1003', 'wamid.2'), text('1004', 'wamid.3')],
      'req-12345678',
    );

    assert.deepEqual(summary, { enqueued: 0, discarded: 3, failed: 0 });
    assert.equal(h.queue.attempts, 0);
    assert.deepEqual(h.results, ['unknown_number', 'client_unavailable', 'unknown_number']);
    const warns = h.logs.lines().filter((line) => line.level === 40);
    assert.equal(warns.length, 3);
  });
});

describe('ChannelIntakeService: avisos constantes (nunca silêncio)', () => {
  it('tipo não textual vira notice unsupported_type; texto inválido vira notice invalid_text', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa', '1001');
    const invalid = [
      ['vazio', ''],
      ['só espaços', '   \n\t '],
      ['maior que 4000', 'x'.repeat(4001)],
      ['com NUL', 'oi\u0000tchau'],
      ['ausente', undefined],
    ] as const;

    const messages = [
      unsupported('1001', 'wamid.u'),
      ...invalid.map(([label, body]) => text('1001', `wamid.${label}`, { body })),
    ];
    const summary = await h.intake.accept(messages, 'req-12345678');

    assert.deepEqual(summary, { enqueued: 6, discarded: 0, failed: 0 });
    const jobs = h.queue.all();
    assert.ok(jobs.every((job) => job.kind === 'notice' && job.clientId === client.id));
    assert.deepEqual(
      jobs.map((job) => (job.kind === 'notice' ? job.reason : undefined)),
      [
        'unsupported_type',
        'invalid_text',
        'invalid_text',
        'invalid_text',
        'invalid_text',
        'invalid_text',
      ],
    );
    assert.deepEqual(h.results, [
      'unsupported_type',
      'invalid_text',
      'invalid_text',
      'invalid_text',
      'invalid_text',
      'invalid_text',
    ]);
  });

  it('texto de 4000 caracteres e com quebra de linha segue sendo texto', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    await h.intake.accept(
      [
        text('1001', 'wamid.max', { body: 'x'.repeat(4000) }),
        text('1001', 'wamid.nl', { body: 'linha 1\nlinha 2' }),
      ],
      'req-12345678',
    );
    assert.deepEqual(
      h.queue.all().map((job) => job.kind),
      ['text', 'text'],
    );
  });
});

describe('ChannelIntakeService: remetente e identificadores', () => {
  it('mensagem sem remetente utilizável é descartada com log e métrica (sem erro)', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    const summary = await h.intake.accept(
      [
        text('1001', 'wamid.1', { sender: undefined }),
        text('1001', 'wamid.2', { sender: '' }),
        text('1001', 'wamid.3', { sender: 'US.13491208655302741918' }),
        text('1001', 'wamid.4', { sender: '1'.repeat(33) }),
        text('1001', 'wamid.5', { sender: '+5511987654321' }),
      ],
      'req-12345678',
    );
    assert.deepEqual(summary, { enqueued: 0, discarded: 5, failed: 0 });
    assert.equal(h.queue.attempts, 0);
    assert.deepEqual(
      h.results,
      Array.from({ length: 5 }, () => 'missing_sender'),
    );
  });

  it('id de mensagem inválido (vazio, grande demais, controle) ou número do negócio inválido é descartado', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    const summary = await h.intake.accept(
      [
        text('1001', ''),
        text('1001', 'x'.repeat(129)),
        text('1001', 'wamid\u0000x'),
        text('abc', 'wamid.ok'),
      ],
      'req-12345678',
    );
    assert.deepEqual(summary, { enqueued: 0, discarded: 4, failed: 0 });
    assert.deepEqual(h.results, [
      'invalid_message',
      'invalid_message',
      'invalid_message',
      'invalid_message',
    ]);
  });

  it('wamid com ":" ou "%" gera um jobId sem ":" (o BullMQ recusa dois-pontos)', () => {
    const id = inboundJobId({
      clientId: '018f3a52-0000-7000-8000-000000000001',
      externalId: 'wamid:abc%def==',
    });
    assert.ok(!id.includes(':'));
    assert.ok(id.startsWith('018f3a52-0000-7000-8000-000000000001_'));
    assert.notEqual(
      inboundJobId({ clientId: 'c', externalId: 'a:b' }),
      inboundJobId({ clientId: 'c', externalId: 'a%3Ab' }),
    );
  });
});

describe('ChannelIntakeService: falhas', () => {
  it('falha ao enfileirar uma mensagem não impede as outras; a reentrega enfileira só o que faltou', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    h.queue.failOn = (job) => job.externalId === 'wamid.2';

    const first = await h.intake.accept(
      [text('1001', 'wamid.1'), text('1001', 'wamid.2'), text('1001', 'wamid.3')],
      'req-aaaaaaaa',
    );
    assert.deepEqual(first, { enqueued: 2, discarded: 0, failed: 1 });
    assert.deepEqual(
      h.queue.all().map((job) => job.externalId),
      ['wamid.1', 'wamid.3'],
    );

    // A Meta reentrega o lote inteiro: o id determinístico não duplica o que já está na fila.
    h.queue.failOn = undefined;
    const second = await h.intake.accept(
      [text('1001', 'wamid.1'), text('1001', 'wamid.2'), text('1001', 'wamid.3')],
      'req-bbbbbbbb',
    );
    assert.deepEqual(second, { enqueued: 3, discarded: 0, failed: 0 });
    assert.deepEqual(
      h.queue
        .all()
        .map((job) => job.externalId)
        .sort(),
      ['wamid.1', 'wamid.2', 'wamid.3'],
    );
  });

  it('banco fora na resolução do cliente conta como falha (500 para a Meta retentar), sem derrubar o lote', async () => {
    const real = new InMemoryClientRepository();
    const h = setup({
      findByWhatsappPhoneNumberId: (id) =>
        id === '1001'
          ? Promise.reject(new DatabaseError('banco fora'))
          : real.findByWhatsappPhoneNumberId(id),
    });
    const other = await newClient({ clients: real }, 'beta', '1002');
    const summary = await h.intake.accept(
      [text('1001', 'wamid.1'), text('1002', 'wamid.2')],
      'req-12345678',
    );
    assert.deepEqual(summary, { enqueued: 1, discarded: 0, failed: 1 });
    assert.equal(h.queue.all()[0]?.clientId, other.id);
  });

  it('métrica que lança não derruba o atendimento da mensagem', async () => {
    const clients = new InMemoryClientRepository();
    const queue = new FakeQueue();
    const intake = new ChannelIntakeService({
      clients,
      queue,
      logger: captureLogs().logger,
      metrics: {
        countChannelInbound() {
          throw new Error('métrica quebrada');
        },
      },
      channel: 'whatsapp',
    });
    await newClient({ clients }, 'alfa', '1001');
    assert.deepEqual(await intake.accept([text('1001', 'wamid.1')], 'req-12345678'), {
      enqueued: 1,
      discarded: 0,
      failed: 0,
    });
  });
});

describe('ChannelIntakeService: privacidade nos logs', () => {
  it('texto, remetente e wamid não aparecem em nenhuma linha de log (sucesso, descartes e falhas)', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    await newClient(h, 'suspenso', '1003', 'SUSPENDED');
    h.queue.failOn = (job) => job.externalId.includes('falha');

    await h.intake.accept(
      [
        text('1001', WAMID),
        text('1001', `${WAMID}-falha`),
        unsupported('1001', `${WAMID}-aviso`),
        text('9999', `${WAMID}-desconhecido`),
        text('1003', `${WAMID}-suspenso`),
        text('1001', `${WAMID}-semremetente`, { sender: undefined }),
      ],
      'req-12345678',
    );

    const everything = h.logs.raw();
    assert.ok(everything.length > 0);
    for (const secret of [
      SECRET_TEXT,
      CONTACT,
      WAMID,
      Buffer.from(`\u001c\u0018\u000b${CONTACT}`).toString('base64'),
    ]) {
      assert.ok(!everything.includes(secret), `vazou em log: ${secret}`);
    }
  });
});

describe('ChannelIntakeService: tipos que não são mensagem do contato', () => {
  it('reação, system, unsupported e tipo desconhecido: sem job, sem aviso, métrica ignored_type e log sem conteúdo', async () => {
    const h = setup();
    await newClient(h, 'alfa', '1001');
    const ignored = (id: string): InboundChannelMessage => ({
      phoneNumberId: '1001',
      messageId: id,
      sender: CONTACT,
      content: { kind: 'ignored' },
    });
    const summary = await h.intake.accept(
      [ignored('wamid.reacao'), ignored('wamid.sistema'), ignored('wamid.novo')],
      'req-12345678',
    );
    assert.deepEqual(summary, { enqueued: 0, discarded: 3, failed: 0 });
    assert.equal(h.queue.attempts, 0);
    assert.deepEqual(h.results, ['ignored_type', 'ignored_type', 'ignored_type']);
    assert.equal(h.lookups, 0, 'nem resolve o cliente');
    assert.ok(h.logs.lines().every((line) => Number(line.level) <= 30));
  });

  it('contentFromType: só áudio, imagem, vídeo, documento, figurinha, localização e contatos recebem aviso; text segue o fluxo; o resto é ignorado', () => {
    for (const type of ['audio', 'image', 'video', 'document', 'sticker', 'location', 'contacts']) {
      assert.deepEqual(contentFromType(type, undefined), { kind: 'unsupported' }, type);
    }
    assert.deepEqual(contentFromType('text', 'oi'), { kind: 'text', text: 'oi' });
    assert.deepEqual(contentFromType('text', undefined), { kind: 'text', text: undefined });
    for (const type of [
      'reaction',
      'system',
      'unsupported',
      'button',
      'interactive',
      'order',
      'inventado',
      '',
      undefined,
    ]) {
      assert.deepEqual(contentFromType(type, 'x'), { kind: 'ignored' }, String(type));
    }
  });
});
