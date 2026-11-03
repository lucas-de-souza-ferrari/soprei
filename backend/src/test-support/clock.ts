/**
 * Relógio dos testes que conferem a ordem de mensagens. Com o relógio real, dois pedidos
 * seguidos podem cair no mesmo milissegundo (runner rápido, tudo em memória) e a resposta do
 * primeiro, que recebe `createdAt = pergunta + 1 ms`, passa a ficar DEPOIS da pergunta
 * seguinte. Este relógio avança `stepMs` a cada leitura e nunca repete um instante.
 */
export function steppingClock(stepMs = 10, startMs: number = Date.UTC(2026, 0, 1)): () => Date {
  let time = startMs;
  return () => {
    time += stepMs;
    return new Date(time);
  };
}
