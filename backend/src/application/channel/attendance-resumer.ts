import { randomUUID } from 'node:crypto';
import {
  RESUME_MAX_COMPANIES_PER_RUN,
  RESUME_MAX_CONTACTS_PER_COMPANY,
  RESUME_MAX_CONTACTS_PER_RUN,
  RESUME_MIN_AGE_MS,
  RESUME_WINDOW_MS,
} from '../../domain/index.js';
import { isPhoneContactRef } from '../attendance/contact-label.js';
import type {
  ResumeAttemptStore,
  ResumeKind,
  ResumeTargetReader,
} from '../ports/attendance-resume.js';
import type { InboundJobQueue, InboundQueueCleaner } from '../ports/inbound-job-queue.js';
import { describeError } from './describe-error.js';

export type ResumeContactResult = 'scheduled' | 'skipped_limit' | 'failed';

export interface AttendanceResumeMetrics {
  countResumeRun(result: 'ok' | 'error'): void;
  countResumeContact(kind: ResumeKind, result: ResumeContactResult): void;
  countQueueCleaned(state: 'completed' | 'failed', jobs: number): void;
}

export interface AttendanceResumeLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface AttendanceResumerDeps {
  readonly reader: ResumeTargetReader;
  readonly attempts: ResumeAttemptStore;
  readonly queue: Pick<InboundJobQueue, 'scheduleFlush'>;
  readonly cleaner: InboundQueueCleaner;
  readonly logger: AttendanceResumeLogger;
  readonly metrics?: AttendanceResumeMetrics | undefined;
  /** Há token global configurado (empresas sem conexão própria podem ser retomadas). */
  readonly legacyTokenConfigured: boolean;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
}

export interface ResumeRunSummary {
  readonly result: 'ok' | 'error';
  readonly scheduled: number;
  readonly skippedLimit: number;
  readonly failed: number;
  readonly cleanedCompleted: number;
  readonly cleanedFailed: number;
}

/**
 * Última execução da retomada e da limpeza (spec 044, E2: a Saúde do admin da plataforma). Fica só em
 * memória, neste processo: some no reinício. Só instante, resultado e contagens; nunca contato nem empresa.
 */
export interface ResumeRunReport {
  readonly at: Date;
  readonly resume: {
    readonly ok: boolean;
    readonly scheduled: number;
    readonly skippedLimit: number;
    readonly failed: number;
  };
  readonly clean: { readonly ok: boolean; readonly completed: number; readonly failed: number };
}

/**
 * Retomada do atendimento (spec 035). A cada execução:
 *
 * 1. lê quem ficou sem resposta no canal (mensagem pendente parada ou resposta gravada e não enviada,
 *    dentro da janela de atendimento), percorrendo as empresas em rodízio;
 * 2. para cada contato com forma de telefone, consome uma tentativa (no máximo
 *    `RESUME_MAX_ATTEMPTS` por dia) e agenda o `flush` em modo `ensure`, sem espera, marcado com
 *    `resume: true`. O `flush` relê tudo no banco (empresa, número, credencial, cota, pausa): este
 *    serviço só o acorda;
 * 3. apaga da fila os jobs concluídos e falhos além dos prazos de retenção.
 *
 * Nunca lança (roda num timer) e nunca loga contato: só contagens. As duas partes são independentes:
 * a limpeza roda mesmo se a retomada falhar.
 */
export class AttendanceResumer {
  private readonly now: () => Date;
  /** Rodízio entre execuções: a próxima continua depois da última empresa lida. */
  private afterCompanyId: string | null = null;
  private last: ResumeRunReport | null = null;

  constructor(private readonly deps: AttendanceResumerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** A última execução neste processo (`null` antes da primeira). */
  lastRun(): ResumeRunReport | null {
    return this.last;
  }

  async runOnce(): Promise<ResumeRunSummary> {
    const resumed = await this.resume();
    const cleaned = await this.clean();
    this.last = {
      at: this.now(),
      resume: {
        ok: resumed.ok,
        scheduled: resumed.scheduled,
        skippedLimit: resumed.skippedLimit,
        failed: resumed.failed,
      },
      clean: { ok: cleaned.ok, completed: cleaned.completed, failed: cleaned.failed },
    };
    const result = resumed.ok && cleaned.ok ? 'ok' : 'error';
    this.count(() => this.deps.metrics?.countResumeRun(result));
    const summary: ResumeRunSummary = {
      result,
      scheduled: resumed.scheduled,
      skippedLimit: resumed.skippedLimit,
      failed: resumed.failed,
      cleanedCompleted: cleaned.completed,
      cleanedFailed: cleaned.failed,
    };
    if (
      summary.scheduled + summary.skippedLimit + summary.failed > 0 ||
      summary.cleanedCompleted + summary.cleanedFailed > 0
    ) {
      this.deps.logger.info({ ...summary }, 'retomada do atendimento e limpeza da fila');
    }
    return summary;
  }

  private async resume(): Promise<{
    ok: boolean;
    scheduled: number;
    skippedLimit: number;
    failed: number;
  }> {
    const { reader, attempts, queue, logger } = this.deps;
    let scheduled = 0;
    let skippedLimit = 0;
    let failed = 0;
    try {
      const scan = await reader.scan({
        now: this.now(),
        minAgeMs: RESUME_MIN_AGE_MS,
        windowMs: RESUME_WINDOW_MS,
        maxCompanies: RESUME_MAX_COMPANIES_PER_RUN,
        maxContactsPerCompany: RESUME_MAX_CONTACTS_PER_COMPANY,
        afterCompanyId: this.afterCompanyId,
        includeLegacy: this.deps.legacyTokenConfigured,
      });
      const startedAfter = this.afterCompanyId;
      this.afterCompanyId = scan.nextCompanyId;
      const runId = randomUUID();
      // Os alvos vêm agrupados por empresa, em ordem de id: ao mudar de empresa, a anterior terminou.
      let lastCompanyDone: string | null = startedAfter;
      let currentCompany: string | null = null;
      for (const target of scan.targets) {
        if (currentCompany !== null && target.companyId !== currentCompany) {
          lastCompanyDone = currentCompany;
        }
        currentCompany = target.companyId;
        if (scheduled >= RESUME_MAX_CONTACTS_PER_RUN) {
          // Teto atingido (revisão da 035, S3): a próxima execução recomeça na empresa que ficou pela
          // metade, sem pular as que nem foram lidas. As já agendadas dela são deduplicadas na fila.
          this.afterCompanyId = lastCompanyDone;
          break;
        }
        // Conversa do simulador nunca vai ao canal (nela `sentAt` é sempre nulo).
        if (!isPhoneContactRef(target.contactRef)) continue;
        if (!(await attempts.take(target.companyId, target.contactRef))) {
          skippedLimit += 1;
          this.count(() => this.deps.metrics?.countResumeContact(target.kind, 'skipped_limit'));
          continue;
        }
        const outcome = await queue.scheduleFlush(
          {
            kind: 'flush',
            companyId: target.companyId,
            phoneNumberId: target.phoneNumberId,
            contactRef: target.contactRef,
            requestId: `resume-${runId}`,
            resume: true,
          },
          { delayMs: 0, mode: 'ensure' },
        );
        if (outcome.ok) {
          scheduled += 1;
          this.count(() => this.deps.metrics?.countResumeContact(target.kind, 'scheduled'));
        } else {
          failed += 1;
          this.count(() => this.deps.metrics?.countResumeContact(target.kind, 'failed'));
        }
      }
      return { ok: failed === 0, scheduled, skippedLimit, failed };
    } catch (error) {
      logger.error(
        { scheduled, skippedLimit, failed, ...describeError(error) },
        'a retomada do atendimento falhou; a próxima execução tenta de novo',
      );
      return { ok: false, scheduled, skippedLimit, failed };
    }
  }

  private async clean(): Promise<{ ok: boolean; completed: number; failed: number }> {
    try {
      const cleaned = await this.deps.cleaner.cleanOldJobs();
      if (!cleaned.ok) {
        this.deps.logger.error(
          { ...describeError(cleaned.error) },
          'a limpeza da fila falhou; a próxima execução tenta de novo',
        );
        return { ok: false, completed: 0, failed: 0 };
      }
      const { completed, failed } = cleaned.value;
      if (completed > 0)
        this.count(() => this.deps.metrics?.countQueueCleaned('completed', completed));
      if (failed > 0) this.count(() => this.deps.metrics?.countQueueCleaned('failed', failed));
      return { ok: true, completed, failed };
    } catch (error) {
      this.deps.logger.error(
        { ...describeError(error) },
        'a limpeza da fila falhou; a próxima execução tenta de novo',
      );
      return { ok: false, completed: 0, failed: 0 };
    }
  }

  /** Falha ao registrar métrica nunca derruba a execução. */
  private count(record: () => void): void {
    try {
      record();
    } catch (error) {
      this.deps.logger.warn({ ...describeError(error) }, 'falha ao registrar métrica da retomada');
    }
  }
}
