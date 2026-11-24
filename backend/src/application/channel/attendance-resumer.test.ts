import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESUME_MAX_COMPANIES_PER_RUN,
  RESUME_MAX_CONTACTS_PER_COMPANY,
  RESUME_MAX_CONTACTS_PER_RUN,
  RESUME_MIN_AGE_MS,
  RESUME_WINDOW_MS,
} from '../../domain/index.js';
import { ExternalServiceError, ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { SITE_TEST_CONTACT_REF } from '../attendance/contact-label.js';
import type {
  ResumeAttemptStore,
  ResumeKind,
  ResumeScan,
  ResumeScanOptions,
  ResumeTarget,
  ResumeTargetReader,
} from '../ports/attendance-resume.js';
import type {
  FlushJob,
  FlushSchedule,
  InboundQueueCleaner,
  QueueCleanResult,
} from '../ports/inbound-job-queue.js';
import { channelJobSchema } from '../ports/inbound-job-queue.js';
import {
  type AttendanceResumeMetrics,
  AttendanceResumer,
  type ResumeContactResult,
} from './attendance-resumer.js';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';
const PHONE_A = '5511990000001';
const PHONE_B = '5511990000002';
const NOW = new Date('2026-11-23T12:00:00.000Z');

const target = (
  companyId: string,
  contactRef: string,
  kind: ResumeKind = 'pending',
): ResumeTarget => ({ companyId, phoneNumberId: `pn-${companyId.slice(-1)}`, contactRef, kind });

class FakeReader implements ResumeTargetReader {
  readonly calls: ResumeScanOptions[] = [];
  constructor(private readonly pages: (ResumeScan | Error)[]) {}
  scan(options: ResumeScanOptions): Promise<ResumeScan> {
    this.calls.push(options);
    const page = this.pages.shift() ?? { targets: [], nextCompanyId: null };
    return page instanceof Error ? Promise.reject(page) : Promise.resolve(page);
  }
}

class FakeAttempts implements ResumeAttemptStore {
  readonly taken = new Map<string, number>();
  failWith: Error | undefined;
  constructor(private readonly limit = 3) {}
  take(companyId: string, contactRef: string): Promise<boolean> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const key = `${companyId}|${contactRef}`;
    const count = this.taken.get(key) ?? 0;
    if (count >= this.limit) return Promise.resolve(false);
    this.taken.set(key, count + 1);
    return Promise.resolve(true);
  }
}

class FakeQueue {
  readonly calls: { job: FlushJob; schedule: FlushSchedule }[] = [];
  failFor = new Set<string>();
  scheduleFlush(job: FlushJob, schedule: FlushSchedule) {
    this.calls.push({ job, schedule });
    return Promise.resolve(
      this.failFor.has(job.contactRef)
        ? Result.err(new ExternalServiceError('fila fora'))
        : Result.ok(undefined),
    );
  }
}

class FakeCleaner implements InboundQueueCleaner {
  calls = 0;
  result: Result<QueueCleanResult, ExternalServiceError> = Result.ok({ completed: 0, failed: 0 });
  cleanOldJobs() {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

class FakeMetrics implements AttendanceResumeMetrics {
  readonly runs: string[] = [];
  readonly contacts: string[] = [];
  readonly cleaned: string[] = [];
  countResumeRun(result: 'ok' | 'error'): void {
    this.runs.push(result);
  }
  countResumeContact(kind: ResumeKind, result: ResumeContactResult): void {
    this.contacts.push(`${kind}:${result}`);
  }
  countQueueCleaned(state: 'completed' | 'failed', jobs: number): void {
    this.cleaned.push(`${state}:${String(jobs)}`);
  }
}

function setup(
  pages: (ResumeScan | Error)[],
  attempts = new FakeAttempts(),
  legacyTokenConfigured = true,
) {
  const reader = new FakeReader(pages);
  const queue = new FakeQueue();
  const cleaner = new FakeCleaner();
  const metrics = new FakeMetrics();
  const logs = captureLogs();
  const resumer = new AttendanceResumer({
    reader,
    attempts,
    queue,
    cleaner,
    logger: logs.logger,
    metrics,
    legacyTokenConfigured,
    now: () => NOW,
  });
  return { reader, attempts, queue, cleaner, metrics, logs, resumer };
}

describe('AttendanceResumer (spec 035)', () => {
  it('agenda o flush de cada contato em modo ensure, sem espera, marcado como retomada, com a empresa e o número lidos do banco', async () => {
    const h = setup([
      {
        targets: [target(COMPANY_A, PHONE_A), target(COMPANY_B, PHONE_B, 'unsent')],
        nextCompanyId: null,
      },
    ]);
    const summary = await h.resumer.runOnce();

    assert.equal(summary.result, 'ok');
    assert.equal(summary.scheduled, 2);
    assert.deepEqual(
      h.queue.calls.map(({ job, schedule }) => ({
        companyId: job.companyId,
        phoneNumberId: job.phoneNumberId,
        contactRef: job.contactRef,
        resume: job.resume,
        kind: job.kind,
        schedule,
      })),
      [
        {
          companyId: COMPANY_A,
          phoneNumberId: 'pn-a',
          contactRef: PHONE_A,
          resume: true,
          kind: 'flush',
          schedule: { delayMs: 0, mode: 'ensure' },
        },
        {
          companyId: COMPANY_B,
          phoneNumberId: 'pn-b',
          contactRef: PHONE_B,
          resume: true,
          kind: 'flush',
          schedule: { delayMs: 0, mode: 'ensure' },
        },
      ],
    );
    assert.match(h.queue.calls[0]?.job.requestId ?? '', /^resume-[0-9a-f-]{36}$/);
    assert.deepEqual(h.metrics.contacts, ['pending:scheduled', 'unsent:scheduled']);
    assert.deepEqual(h.metrics.runs, ['ok']);
  });

  it('pede ao leitor os limites da spec e o relógio injetado', async () => {
    const h = setup([{ targets: [], nextCompanyId: null }]);
    await h.resumer.runOnce();
    assert.deepEqual(h.reader.calls[0], {
      now: NOW,
      minAgeMs: RESUME_MIN_AGE_MS,
      windowMs: RESUME_WINDOW_MS,
      maxCompanies: RESUME_MAX_COMPANIES_PER_RUN,
      maxContactsPerCompany: RESUME_MAX_CONTACTS_PER_COMPANY,
      afterCompanyId: null,
      includeLegacy: true,
    });
    assert.equal(RESUME_MIN_AGE_MS, 5 * 60_000);
    // Sem token global, empresas sem conexão própria ficam de fora (revisão, S6).
    const noLegacy = setup([{ targets: [], nextCompanyId: null }], new FakeAttempts(), false);
    await noLegacy.resumer.runOnce();
    assert.equal(noLegacy.reader.calls[0]?.includeLegacy, false);
    assert.equal(RESUME_WINDOW_MS, 23 * 3_600_000);
  });

  it('rodízio: a execução seguinte continua depois da última empresa lida e recomeça quando a lista acaba', async () => {
    const h = setup([
      { targets: [], nextCompanyId: COMPANY_A },
      { targets: [], nextCompanyId: null },
      { targets: [], nextCompanyId: null },
    ]);
    await h.resumer.runOnce();
    await h.resumer.runOnce();
    await h.resumer.runOnce();
    assert.deepEqual(
      h.reader.calls.map((call) => call.afterCompanyId),
      [null, COMPANY_A, null],
    );
  });

  it('nunca agenda conversa do simulador nem o contato fixo do teste do site', async () => {
    const h = setup([
      {
        targets: [
          target(COMPANY_A, 'contato-1'),
          target(COMPANY_A, SITE_TEST_CONTACT_REF),
          target(COMPANY_A, '123'),
          target(COMPANY_A, PHONE_A),
        ],
        nextCompanyId: null,
      },
    ]);
    const summary = await h.resumer.runOnce();
    assert.equal(summary.scheduled, 1);
    assert.deepEqual(
      h.queue.calls.map((call) => call.job.contactRef),
      [PHONE_A],
    );
    assert.equal(h.attempts.taken.size, 1, 'só o telefone consome tentativa');
  });

  it('o contato que gastou as tentativas não é agendado e conta skipped_limit', async () => {
    const attempts = new FakeAttempts(3);
    const page = (): ResumeScan => ({
      targets: [target(COMPANY_A, PHONE_A)],
      nextCompanyId: null,
    });
    const h = setup([page(), page(), page(), page()], attempts);
    for (let run = 0; run < 4; run += 1) await h.resumer.runOnce();
    assert.equal(h.queue.calls.length, 3);
    assert.deepEqual(h.metrics.contacts.slice(-1), ['pending:skipped_limit']);
  });

  it('para no teto de contatos por execução e a seguinte recomeça na empresa que ficou pela metade (revisão, S3)', async () => {
    const ofA = Array.from({ length: 150 }, (_, index) =>
      target(COMPANY_A, `55119${String(index).padStart(8, '0')}`),
    );
    const ofB = Array.from({ length: 80 }, (_, index) =>
      target(COMPANY_B, `55118${String(index).padStart(8, '0')}`),
    );
    const h = setup([
      { targets: [...ofA, ...ofB], nextCompanyId: COMPANY_B },
      { targets: [], nextCompanyId: null },
    ]);
    const summary = await h.resumer.runOnce();
    assert.equal(summary.scheduled, RESUME_MAX_CONTACTS_PER_RUN);
    assert.equal(h.queue.calls.length, RESUME_MAX_CONTACTS_PER_RUN);
    await h.resumer.runOnce();
    // A empresa A terminou; a B ficou pela metade: a próxima leitura começa depois da A, não da B.
    assert.equal(h.reader.calls[1]?.afterCompanyId, COMPANY_A);
  });

  it('falha ao agendar um contato conta failed, segue com os outros e a execução termina com error', async () => {
    const h = setup([
      {
        targets: [target(COMPANY_A, PHONE_A), target(COMPANY_B, PHONE_B)],
        nextCompanyId: null,
      },
    ]);
    h.queue.failFor.add(PHONE_A);
    const summary = await h.resumer.runOnce();
    assert.equal(summary.scheduled, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.result, 'error');
    assert.deepEqual(h.metrics.runs, ['error']);
  });

  it('leitor ou contador fora: não lança, conta error, loga sem contato e a limpeza roda mesmo assim', async () => {
    const readerDown = setup([new Error('banco fora')]);
    const first = await readerDown.resumer.runOnce();
    assert.equal(first.result, 'error');
    assert.equal(readerDown.cleaner.calls, 1);

    const attempts = new FakeAttempts();
    attempts.failWith = new ServiceUnavailableError('redis fora');
    const redisDown = setup(
      [{ targets: [target(COMPANY_A, PHONE_A)], nextCompanyId: null }],
      attempts,
    );
    const second = await redisDown.resumer.runOnce();
    assert.equal(second.result, 'error');
    assert.equal(redisDown.queue.calls.length, 0, 'sem contar, não agenda');
    assert.equal(redisDown.cleaner.calls, 1);
    const line = redisDown.logs
      .lines()
      .find((entry) => String(entry.msg).includes('a retomada do atendimento falhou'));
    assert.equal(line?.level, 50);
    assert.ok(!redisDown.logs.raw().includes(PHONE_A), 'o contato nunca vai ao log');
  });

  it('limpeza da fila: conta os jobs apagados por estado; falha da limpeza vira error', async () => {
    const h = setup([{ targets: [], nextCompanyId: null }]);
    h.cleaner.result = Result.ok({ completed: 4, failed: 1 });
    const ok = await h.resumer.runOnce();
    assert.equal(ok.cleanedCompleted, 4);
    assert.equal(ok.cleanedFailed, 1);
    assert.deepEqual(h.metrics.cleaned, ['completed:4', 'failed:1']);

    h.cleaner.result = Result.err(new ExternalServiceError('redis fora'));
    const failed = await h.resumer.runOnce();
    assert.equal(failed.result, 'error');
  });

  it('o log da execução só tem contagens: nem contato, nem empresa', async () => {
    const h = setup([
      {
        targets: [target(COMPANY_A, PHONE_A), target(COMPANY_B, PHONE_B, 'unsent')],
        nextCompanyId: null,
      },
    ]);
    await h.resumer.runOnce();
    const raw = h.logs.raw();
    for (const secret of [PHONE_A, PHONE_B, COMPANY_A, COMPANY_B]) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
    const line = h.logs
      .lines()
      .find((entry) => String(entry.msg).includes('retomada do atendimento e limpeza'));
    assert.equal(line?.scheduled, 2);
  });
});

describe('formato do job de flush (spec 035)', () => {
  it('o campo resume é opcional: job antigo sem ele continua válido; com ele, só booleano', () => {
    const base = {
      kind: 'flush',
      companyId: COMPANY_A,
      phoneNumberId: '106540352242922',
      contactRef: PHONE_A,
      requestId: 'req-12345678',
    };
    assert.ok(channelJobSchema.safeParse(base).success, 'formato antigo');
    assert.ok(channelJobSchema.safeParse({ ...base, resume: true }).success);
    assert.equal(channelJobSchema.safeParse({ ...base, resume: 'sim' }).success, false);
  });
});
