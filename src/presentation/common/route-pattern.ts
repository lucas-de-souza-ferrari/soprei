import type { FastifyRequest } from 'fastify';

/** Valor do label `route` (e do log) quando nenhuma rota casou; mantém a cardinalidade fixa. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Padrão da rota que atendeu a requisição (`/admin/clients/:id`), nunca a URL crua: o id
 * real não pode virar label de métrica nem aparecer no log. Barra final é normalizada
 * (`/admin/clients/` e `/admin/clients` são a mesma rota).
 */
export function routePattern(request: FastifyRequest): string {
  const url = request.is404 ? undefined : request.routeOptions.url;
  if (url === undefined || url === '' || url === '*' || url === '/*') return UNMATCHED_ROUTE;
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}
