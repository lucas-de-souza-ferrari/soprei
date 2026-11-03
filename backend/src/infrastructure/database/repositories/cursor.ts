import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type ListOptions,
  type Page,
} from '../../../domain/index.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';

/** Posição numa listagem ordenada por `createdAt` e `id` (ambos crescentes). */
export interface CursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** Linha mínima que uma listagem paginada precisa ter. */
export interface PagedRow {
  readonly id: string;
  readonly createdAt: Date;
}

/** Ordem estável das listagens: desempata `createdAt` pelo `id`. */
export type StableOrderBy = [{ createdAt: 'asc' }, { id: 'asc' }];

export function stableOrderBy(): StableOrderBy {
  return [{ createdAt: 'asc' }, { id: 'asc' }];
}

/** Condição "depois do cursor" para a ordem (`createdAt`, `id`). */
export type AfterCursor = { createdAt: { gt: Date } } | { createdAt: Date; id: { gt: string } };

/** Ordem decrescente (mais recentes primeiro), usada pela trilha de auditoria. */
export type DescOrderBy = [{ createdAt: 'desc' }, { id: 'desc' }];

export function descOrderBy(): DescOrderBy {
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

/** Condição "depois do cursor" para a ordem decrescente (`createdAt`, `id`). */
export type AfterCursorDesc = { createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } };

/** Cursor opaco para quem chama; por dentro, `[createdAt ISO, id]` em base64url. */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt.toISOString(), position.id])).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): CursorPosition {
  const invalid = (): never => {
    throw new ValidationError('Cursor inválido');
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return invalid();
  const [createdAt, id] = parsed as readonly unknown[];
  if (typeof createdAt !== 'string' || !isUuid(id)) return invalid();
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) return invalid();
  return { createdAt: date, id: id.toLowerCase() };
}

export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ValidationError(`limit deve ser um inteiro entre 1 e ${String(MAX_LIST_LIMIT)}`);
  }
  return limit;
}

export interface PageQuery {
  readonly limit: number;
  /** Uma linha a mais que o limite: sobrar uma linha diz que há próxima página. */
  readonly take: number;
  /** Vai em `OR` no `where` (array mutável, como o Prisma pede). */
  readonly after: AfterCursor[] | undefined;
}

/** Valida `limit` e `cursor` (400 se inválidos) e monta o que a consulta precisa. */
export function buildPageQuery(options: ListOptions | undefined): PageQuery {
  const limit = resolveLimit(options?.limit);
  const cursor = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);
  return {
    limit,
    take: limit + 1,
    after:
      cursor === undefined
        ? undefined
        : [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
  };
}

/** Como `buildPageQuery`, para a ordem decrescente: o cursor vira "antes de (createdAt, id)". */
export function buildDescPageQuery(options: ListOptions | undefined): {
  readonly limit: number;
  readonly take: number;
  readonly after: AfterCursorDesc[] | undefined;
} {
  const limit = resolveLimit(options?.limit);
  const cursor = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);
  return {
    limit,
    take: limit + 1,
    after:
      cursor === undefined
        ? undefined
        : [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
  };
}

export function toPage<TRow extends PagedRow, T>(
  rows: readonly TRow[],
  limit: number,
  map: (row: TRow) => T,
): Page<T> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const hasMore = rows.length > limit && last !== undefined;
  return {
    items: pageRows.map(map),
    nextCursor: hasMore ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
