import type { onRequestAsyncHookHandler } from 'fastify';
import { bearerAuthHook } from '../bearer-auth.hook.js';
import { routePattern } from '../route-pattern.js';

/**
 * Autenticação das rotas `/admin`: `Authorization: Bearer <ADMIN_API_KEY>` (comparação em
 * tempo constante, ver `bearerAuthHook`). O log de recusa registra o padrão da rota, nunca
 * a URL crua nem a chave.
 *
 * Credencial temporária e válida para TODOS os clientes; o destino dela fica para as
 * specs 007/008. O rate limit do perfil `admin` (spec 005) roda antes deste hook (`onRequest` do plugin), então
 * tentativas de adivinhar a chave também contam.
 */
export function adminAuthHook(apiKey: string | undefined): onRequestAsyncHookHandler {
  return bearerAuthHook(apiKey, (request) => {
    request.log.warn({ route: routePattern(request) }, 'acesso administrativo recusado');
  });
}
