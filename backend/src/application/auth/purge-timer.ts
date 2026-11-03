/** Agendador mínimo (os testes injetam um falso; o padrão usa os timers do Node). */
export interface PurgeScheduler {
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  setInterval(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  clearInterval(handle: NodeJS.Timeout): void;
}

const nodeScheduler: PurgeScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
  clearInterval: (handle) => {
    clearInterval(handle);
  },
};

/** Primeira execução curta depois do boot (spec 021). */
export const PURGE_FIRST_RUN_DELAY_MS = 30_000;

export interface PurgeTimer {
  /** Para os timers e espera a execução em curso terminar. */
  stop(): Promise<void>;
}

/**
 * Timer do expurgo no próprio processo (spec 021): primeira execução depois de ~30 s e depois a
 * cada `intervalMinutes`; `0` não agenda nada (devolve `undefined`). Os timers são `unref` (não
 * seguram o processo vivo), uma execução em curso faz o tique seguinte pular (sem sobreposição) e
 * `stop()` espera a execução ativa. `run` nunca deve rejeitar (o `UnverifiedAccountPurger.runOnce`
 * não rejeita); mesmo assim a rejeição seria engolida aqui.
 */
export function startPurgeTimer(options: {
  /** Só com contas globais ligadas (`ACCOUNTS_ENABLED=true`); desligado não agenda nada. */
  enabled: boolean;
  run: () => Promise<unknown>;
  intervalMinutes: number;
  firstRunDelayMs?: number;
  scheduler?: PurgeScheduler;
}): PurgeTimer | undefined {
  if (!options.enabled || options.intervalMinutes <= 0) return undefined;
  const scheduler = options.scheduler ?? nodeScheduler;
  let active: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped || active !== undefined) return;
    const current: Promise<void> = options
      .run()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (active === current) active = undefined;
      });
    active = current;
  };
  const first = scheduler.setTimeout(tick, options.firstRunDelayMs ?? PURGE_FIRST_RUN_DELAY_MS);
  first.unref();
  const every = scheduler.setInterval(tick, options.intervalMinutes * 60_000);
  every.unref();
  return {
    async stop() {
      stopped = true;
      scheduler.clearTimeout(first);
      scheduler.clearInterval(every);
      await active;
    },
  };
}
