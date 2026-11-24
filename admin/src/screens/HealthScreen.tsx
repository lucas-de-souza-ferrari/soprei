import { useEffect, useRef } from 'react';
import { useLoad } from '../admin-context';
import {
  QUEUE_JOB_STATES,
  SALES_CONTACT_RESULTS,
  countEntries,
  healthSchema,
  type Health,
  type ResumeHealth,
} from '../contracts';
import { errorMessage, formatCount, formatDateTime, label } from '../format';
import { Alert, Badge, Card, Facts, Loading, PageHeader } from '../ui';

/** Intervalo da releitura automática da Saúde (spec 044, E3), só com a aba visível. */
export const HEALTH_REFRESH_MS = 60_000;

/**
 * Chama `tick` a cada `ms` enquanto a aba está visível; ao voltar a ficar visível, relê na hora se o
 * intervalo já passou. Com a aba escondida não há chamada nenhuma.
 */
function useVisibleInterval(tick: () => void, ms: number): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    let last = Date.now();
    const run = () => {
      last = Date.now();
      tickRef.current();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, ms);
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= ms) run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}

function okText(ok: boolean): string {
  return ok ? 'ok' : 'com erro';
}

function resumeText(run: ResumeHealth): string {
  switch (run.state) {
    case 'disabled':
      return 'Desligada';
    case 'not_run':
      return 'Ainda não rodou';
    case 'ran':
      return `${okText(run.resume.ok)} em ${formatDateTime(run.at)} (agendadas: ${formatCount(run.resume.scheduled)}, acima do limite diário: ${formatCount(run.resume.skippedLimit)}, falhas: ${formatCount(run.resume.failed)})`;
  }
}

function cleanText(run: ResumeHealth): string {
  if (run.state !== 'ran') return resumeText(run);
  return `${okText(run.clean.ok)} em ${formatDateTime(run.at)} (concluídos removidos: ${formatCount(run.clean.completed)}, falhos removidos: ${formatCount(run.clean.failed)})`;
}

function UpDown({ value }: { readonly value: 'up' | 'down' }) {
  return <Badge tone={value === 'up' ? 'good' : 'bad'}>{label(value)}</Badge>;
}

/** Estados da fila: os conhecidos na ordem fixa, depois qualquer outro que o servidor mande. */
function queueText(queue: Health['queue']) {
  if (queue.state === 'unavailable') return <Badge tone="bad">Indisponível</Badge>;
  if (queue.state === 'disabled') return 'Desligada';
  const known: readonly string[] = QUEUE_JOB_STATES;
  const entries = [
    ...QUEUE_JOB_STATES.filter((key) => key in queue.jobs).map(
      (key) => [key, queue.jobs[key] ?? 0] as const,
    ),
    ...Object.entries(queue.jobs).filter(([key]) => !known.includes(key)),
  ];
  return entries.length === 0
    ? 'Vazia'
    : entries.map(([key, value]) => `${label(key)}: ${formatCount(value)}`).join(' · ');
}

/** Os contadores fixos da E2, com nome em português. */
function counterFacts(counters: Health['counters']): (readonly [string, string])[] {
  return [
    ['Respostas de fallback', formatCount(counters.attendanceFallbacks)],
    ['Respostas não enviadas', formatCount(counters.attendanceUnsentReplies)],
    ['Envios pelo canal: ok', formatCount(counters.channelSend.ok)],
    ['Envios pelo canal: erro', formatCount(counters.channelSend.error)],
    ['Jobs da fila que falharam', formatCount(counters.queueJobsFailed)],
    ['Erros fatais do processo', formatCount(counters.processFatalErrors)],
    ['Erros ao conferir o plano', formatCount(counters.entitlementErrors)],
    ['Erros ao medir o uso', formatCount(counters.usageMeterErrors)],
    ['Avisos de cobrança que falharam', formatCount(counters.billingNoticesFailed)],
    ...countEntries(SALES_CONTACT_RESULTS, counters.salesContactRequests).map(
      ([key, value]) => [`Contato comercial: ${label(key)}`, formatCount(value)] as const,
    ),
  ];
}

/** Saúde (`GET /platform/health`). Os contadores são do processo que respondeu, desde o boot. */
export function HealthScreen() {
  const { data, error, loading, reload } = useLoad(
    (api) => api.get('/platform/health', healthSchema),
    'health',
  );
  useVisibleInterval(reload, HEALTH_REFRESH_MS);

  return (
    <>
      <PageHeader title="Saúde" onRefresh={reload} busy={loading} />
      {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
      {data === undefined ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <div className="flex flex-col gap-4">
          <Card title="Serviços">
            <Facts
              items={[
                ['Banco de dados', <UpDown key="db" value={data.database} />],
                ['Redis', <UpDown key="redis" value={data.redis} />],
                ['Fila de entrada', queueText(data.queue)],
                ['Última retomada', resumeText(data.resume)],
                ['Última limpeza da fila', cleanText(data.resume)],
                ['Processo no ar desde', formatDateTime(data.bootedAt)],
                ['Conferido em', formatDateTime(data.checkedAt)],
              ]}
            />
          </Card>
          <Card title="Contadores desde o boot">
            <p className="mb-2 text-xs text-muted-foreground">
              Valem para o processo que respondeu. Detalhes de erro ficam nos logs do servidor.
            </p>
            <Facts items={counterFacts(data.counters)} />
          </Card>
        </div>
      )}
    </>
  );
}
