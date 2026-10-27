import type { onRequestAsyncHookHandler } from 'fastify';
import { bearerAuthHook } from '../bearer-auth.hook.js';
import { routePattern } from '../route-pattern.js';

/**
 * Autenticação das rotas `/admin`: `Authorization: Bearer <ADMIN_API_KEY>` (comparação em
 * tempo constante, ver `bearerAuthHook`). O log de recusa registra o padrão da rota, nunca
 * a URL crua nem a chave.
 *
 * Credencial temporária e válida para TODOS os clientes; o destino dela fica para as
 * specs 007/008. Não há rate limit até a spec 005 (risco conhecido).
 */
export function adminAuthHook(apiKey: string | undefined): onRequestAsyncHookHandler {
  return bearerAuthHook(apiKey, (request) => {
    request.log.warn({ route: routePattern(request) }, 'acesso administrativo recusado');
  });
}
