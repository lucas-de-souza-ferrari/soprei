import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Company, MESSAGE_CONTENT_MAX_LENGTH } from '../../domain/index.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import {
  type InboundJob,
  type InboundJobQueue,
  inboundJobId,
  inboundJobSchema,
} from '../ports/inbound-job-queue.js';
import {
  type ChannelEchoIntakeResult,
  ChannelIntakeService,
  type InboundChannelEcho,
  truncateEchoText,
} from './channel-intake.service.js';

const CONTACT = '5511987654321';
const SECRET_TEXT = 'texto-secreto-da-equipe-intake-039';
const ECHO_ID = `wamid.${Buffer.from(CONTACT).toString('base64')}ECO`;

class FakeQueue implements Pick<InboundJobQueue, 'enqueue'> {
  readonly jobs = new Map<string, InboundJob>();
  fail = false;
  enqueue(job: InboundJob): Promise<Result<void, ExternalServiceError>> {
    if (this.fail) return Promise.resolve(Result.err(new ExternalServiceError('fila fora')));
    const id = inboundJobId(job);
    if (!this.jobs.has(id)) this.jobs.set(id, job);
    return Promise.resolve(Result.ok(undefined));
  }
}

function setup() {
  const companies = new InMemoryCompanyRepository();
  const queue = new FakeQueue();
  const results: ChannelEchoIntakeResult[] = [];
  const logs = captureLogs();
  const intake = new ChannelIntakeService({
    companies,
    queue,
    logger: logs.logger,
    metrics: {
      countChannelInbound: () => undefined,
      countChannelEcho: (result) => {
        results.push(result);
      },
    },
    channel: 'whatsapp',
  });
  return { companies, queue, results, logs, intake };
}

async function newCompany(
  h: ReturnType<typeof setup>,
  slug: string,
  number: string,
  status: Company['status'] = 'ACTIVE',
): Promise<Company> {
  const created = await h.companies.create({ name: `Empresa ${slug}`, slug, status });
  return h.companies.update(created.id, { whatsappPhoneNumberId: number });
}

const echo = (number: string, fields: Partial<InboundChannelEcho> = {}): InboundChannelEcho => ({
  phoneNumberId: number,
  messageId: ECHO_ID,
  recipient: CONTACT,
  content: { kind: 'text', text: SECRET_TEXT },
  receivedAt: new Date(Date.UTC(2026, 10, 12, 12)),
  ...fields,
});

describe('ChannelIntakeService.acceptEchoes (spec 039)', () => {
  it('resolve a empresa pelo número e enfileira um job echo com o "to" como contato', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa', '111');

    const summary = await h.intake.acceptEchoes([echo('111')], 'req-1');

    assert.deepEqual(summary, { enqueued: 1, discarded: 0, failed: 0 });
    const [job] = [...h.queue.jobs.values()];
    assert.ok(job);
    assert.equal(inboundJobSchema.safeParse(job).success, true, 'o job passa no schema da fila');
    assert.deepEqual(job, {
      kind: 'echo',
      companyId: company.id,
      phoneNumberId: '111',
      contactRef: CONTACT,
      externalId: ECHO_ID,
      requestId: 'req-1',
      receivedAt: '2026-11-12T12:00:00.000Z',
      text: SECRET_TEXT,
    });
    assert.equal(logContains(h.logs.raw(), SECRET_TEXT), false);
    assert.equal(logContains(h.logs.raw(), CONTACT), false);
    assert.equal(logContains(h.logs.raw(), ECHO_ID), false);
  });

  it('isolamento: o número da A nunca enfileira para a B; número desconhecido = unknown_number', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa', '111');
    await newCompany(h, 'beta', '222');

    await h.intake.acceptEchoes([echo('111'), echo('999', { messageId: 'wamid.outro' })], 'req');

    const jobs = [...h.queue.jobs.values()];
    assert.deepEqual(
      jobs.map((job) => job.companyId),
      [a.id],
    );
    assert.deepEqual(h.results, ['unknown_number']);
  });

  it('empresa suspensa: descartado; sem destinatário ou id utilizável: invalid', async () => {
    const h = setup();
    await newCompany(h, 'alfa', '111', 'SUSPENDED');
    await newCompany(h, 'beta', '222');

    const summary = await h.intake.acceptEchoes(
      [
        echo('111'),
        echo('222', { recipient: undefined }),
        echo('222', { recipient: '+55 11 9999' }),
        echo('222', { messageId: '' }),
      ],
      'req',
    );

    assert.deepEqual(summary, { enqueued: 0, discarded: 4, failed: 0 });
    assert.deepEqual(h.results, ['discarded', 'invalid', 'invalid', 'invalid']);
  });

  it('mídia e texto vazio vão sem texto; texto enorme é cortado no teto', async () => {
    const h = setup();
    await newCompany(h, 'alfa', '111');
    await h.intake.acceptEchoes(
      [
        echo('111', { messageId: 'wamid.m', content: { kind: 'media' } }),
        echo('111', { messageId: 'wamid.v', content: { kind: 'text', text: '  ' } }),
        echo('111', {
          messageId: 'wamid.g',
          content: { kind: 'text', text: '😀'.repeat(MESSAGE_CONTENT_MAX_LENGTH) },
        }),
      ],
      'req',
    );
    const jobs = [...h.queue.jobs.values()] as Extract<InboundJob, { kind: 'echo' }>[];
    assert.equal(jobs[0]?.text, undefined);
    assert.equal(jobs[1]?.text, undefined);
    assert.ok((jobs[2]?.text?.length ?? 0) <= MESSAGE_CONTENT_MAX_LENGTH);
    assert.equal(inboundJobSchema.safeParse(jobs[2]).success, true);
    assert.equal(truncateEchoText('😀😀'), '😀😀');
  });

  it('eco de tipo não tratado (reação, sistema...): sem job, métrica ignored_type, sem texto em log (I-2)', async () => {
    const h = setup();
    await newCompany(h, 'alfa', '111');
    const summary = await h.intake.acceptEchoes(
      [echo('111', { content: { kind: 'ignored' } })],
      'req',
    );
    assert.deepEqual(summary, { enqueued: 0, discarded: 1, failed: 0 });
    assert.equal(h.queue.jobs.size, 0);
    assert.deepEqual(h.results, ['ignored_type']);
    assert.equal(logContains(h.logs.raw(), CONTACT), false);
    assert.equal(logContains(h.logs.raw(), ECHO_ID), false);
  });

  it('o mesmo eco reentregue não duplica o job (id determinístico)', async () => {
    const h = setup();
    await newCompany(h, 'alfa', '111');
    await h.intake.acceptEchoes([echo('111')], 'req-1');
    await h.intake.acceptEchoes([echo('111')], 'req-2');
    assert.equal(h.queue.jobs.size, 1);
  });

  it('fila fora: failed (o webhook responde 500)', async () => {
    const h = setup();
    await newCompany(h, 'alfa', '111');
    h.queue.fail = true;
    const summary = await h.intake.acceptEchoes([echo('111')], 'req');
    assert.deepEqual(summary, { enqueued: 0, discarded: 0, failed: 1 });
  });
});
