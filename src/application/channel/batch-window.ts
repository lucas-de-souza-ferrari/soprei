/**
 * Espera até o `flush` de um contato rodar (janela deslizante com teto, spec 013).
 *
 * - Cada mensagem nova reinicia a espera de `windowMs`.
 * - O teto (`maxWaitMs`) conta desde a **mais antiga** mensagem pendente: o contato que não para de
 *   escrever recebe resposta ao completar o teto, mesmo que a janela nunca tenha ficado quieta.
 * - `windowMs = 0` desliga a espera (a resposta sai assim que o worker puder).
 *
 * Só usa instantes gravados no banco (`createdAt` da mais antiga pendente e da mensagem de
 * referência), nunca o relógio local: com várias instâncias do servidor, relógios diferentes não
 * mudam a conta. `referenceAt` é o instante da mensagem que está sendo agendada (o "agora" dela).
 */
export function flushDelayMs(input: {
  readonly windowMs: number;
  readonly maxWaitMs: number;
  readonly oldestPendingAt: Date | null;
  readonly referenceAt: Date;
}): number {
  const { windowMs, maxWaitMs, oldestPendingAt, referenceAt } = input;
  if (windowMs <= 0) return 0;
  if (oldestPendingAt === null) return windowMs;
  const waitedMs = Math.max(0, referenceAt.getTime() - oldestPendingAt.getTime());
  return Math.min(windowMs, Math.max(0, maxWaitMs - waitedMs));
}
