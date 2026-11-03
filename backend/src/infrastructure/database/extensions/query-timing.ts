export interface QueryTimingSample {
  readonly model: string;
  readonly operation: string;
  readonly durationSeconds: number;
}

/** Recebe a duração de cada query de model do Prisma (ex.: para um histograma). */
export type QueryObserver = (sample: QueryTimingSample) => void;

/**
 * Prisma Client Extension que mede cada operação de model e entrega a duração ao observer.
 *
 * Ordem das extensões (decisão da spec 004): ela é aplicada DEPOIS da `tenant-scope`. O
 * Prisma executa as extensões de query na ordem em que foram adicionadas (a primeira é a
 * mais externa), então a `tenant-scope` continua sendo a primeira a rodar e rejeita a
 * operação sem escopo antes de qualquer outra coisa; esta extensão só enxerga (e mede) o
 * que a barreira deixou passar, ou seja, o tempo real da ida ao banco. Um teste fixa a ordem.
 *
 * O observer nunca derruba a query: o chamador o entrega já protegido (`safeObserver`).
 */
export function queryTimingExtension(observe: QueryObserver) {
  return {
    name: 'query-timing',
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model: string;
          operation: string;
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }) {
          const start = performance.now();
          try {
            return await query(args);
          } finally {
            observe({ model, operation, durationSeconds: (performance.now() - start) / 1000 });
          }
        },
      },
    },
  };
}
