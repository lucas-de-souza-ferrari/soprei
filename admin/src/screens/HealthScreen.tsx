import { useEffect, useRef } from 'react';
import { useLoad } from '../admin-context';
import { healthSchema, type Health, type JobRun } from '../contracts';
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

function jobText(job: JobRun): string {
  switch (job.status) {
    case 'disabled':
      return 'Desligada';
    case 'never':
      return 'Ainda não rodou';
    case 'ran':
      return `${label(job.result)} em ${formatDateTime(job.at)}${
        job.counts.length === 0
          ? ''
          : ` (${job.counts.map((c) => `${label(c.key)}: ${formatCount(c.count)}`).join(', ')})`
      }`;
  }
}

function UpDown({ value }: { readonly value: 'up' | 'down' }) {
  return <Badge tone={value === 'up' ? 'good' : 'bad'}>{label(value)}</Badge>;
}

function queueText(queue: Health['queue']) {
  if (queue.status === 'unavailable') return <Badge tone="bad">Indisponível</Badge>;
  if (queue.status === 'disabled') return 'Desligada';
  return queue.counts.length === 0
    ? 'Vazia'
    : queue.counts.map((c) => `${label(c.key)}: ${formatCount(c.count)}`).join(' · ');
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
                ['Última retomada', jobText(data.resume)],
                ['Última limpeza', jobText(data.cleanup)],
                ['Processo no ar desde', formatDateTime(data.bootedAt)],
                ['Conferido em', formatDateTime(data.checkedAt)],
              ]}
            />
          </Card>
          <Card title="Contadores desde o boot">
            <p className="mb-2 text-xs text-muted-foreground">
              Valem para o processo que respondeu. Detalhes de erro ficam nos logs do servidor.
            </p>
            {data.counters.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum.</p>
            ) : (
              <Facts
                items={data.counters.map(
                  (c) =>
                    [
                      c.label === null ? c.name : `${c.name} (${c.label})`,
                      formatCount(c.value),
                    ] as const,
                )}
              />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
