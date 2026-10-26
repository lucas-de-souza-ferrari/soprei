export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export interface ListOptions {
  /** Itens por página: 1 a `MAX_LIST_LIMIT`; padrão `DEFAULT_LIST_LIMIT`. */
  readonly limit?: number;
  /** `nextCursor` da página anterior; opaco para quem chama. */
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Nulo na última página. */
  readonly nextCursor: string | null;
}
