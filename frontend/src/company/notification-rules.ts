/**
 * Regras puras do sino de notificações (spec 038): texto do selo, quando avisar a chegada e o
 * temporizador da leitura do resumo (30 s com a aba visível, pausado com ela oculta). Relógio e
 * visibilidade entram por parâmetro, para os testes.
 */
export const NOTIFICATION_POLL_MS = 30_000;

/** Texto do selo: nada com zero, o número até 99 e "99+" acima disso. */
export function badgeText(open: number): string {
  if (open <= 0) return '';
  return open > 99 ? '99+' : String(open);
}

/** Nome acessível do sino. */
export function bellLabel(open: number): string {
  if (open <= 0) return 'Notificações';
  return open === 1 ? 'Notificações, 1 aberta' : `Notificações, ${badgeText(open)} abertas`;
}

/** Avisa só quando a contagem SOBE entre duas leituras (a primeira leitura nunca avisa). */
export function shouldAnnounce(previous: number | null, next: number): boolean {
  return previous !== null && next > previous;
}

export interface PollerDeps {
  /** Lê o número de abertas; a falha é engolida (o sino mantém o último valor). */
  readonly read: () => Promise<number>;
  readonly onCount: (open: number) => void;
  readonly isVisible: () => boolean;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly intervalMs?: number;
}

/**
 * Lê ao começar, a cada `intervalMs` com a aba visível e ao voltar a ficar visível. Com a aba oculta o
 * temporizador para. `stop()` descarta qualquer resposta que chegue depois (troca de empresa).
 */
export class SummaryPoller {
  private timer: unknown = undefined;
  private stopped = false;
  private generation = 0;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    void this.tick();
  }

  /** Chamar no evento `visibilitychange`. */
  visibilityChanged(): void {
    if (this.stopped) return;
    if (this.deps.isVisible()) {
      void this.tick();
    } else {
      this.clear();
    }
  }

  /** Releitura imediata (ex.: depois de resolver uma notificação). */
  refresh(): void {
    if (!this.stopped) void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    this.clear();
    const stamp = ++this.generation;
    try {
      const open = await this.deps.read();
      if (this.stopped || stamp !== this.generation) return;
      this.deps.onCount(open);
    } catch {
      // Falha de leitura não aparece no sino (mantém o último valor) nem acelera a próxima.
      if (this.stopped || stamp !== this.generation) return;
    }
    if (this.deps.isVisible()) {
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        void this.tick();
      }, this.deps.intervalMs ?? NOTIFICATION_POLL_MS);
    }
  }
}
