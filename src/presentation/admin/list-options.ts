import type { ListOptions } from '../../domain/index.js';

/** `limit` e `cursor` já validados da query para as `ListOptions` do domínio. */
export function toListOptions(query: {
  limit?: number | undefined;
  cursor?: string | undefined;
}): ListOptions {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}
