import { createHash, timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler } from 'fastify';
import { UnauthorizedError } from '../../shared/errors/index.js';

const BEARER = /^Bearer (\S+)$/i;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Autenticação das rotas `/admin`: `Authorization: Bearer <ADMIN_API_KEY>`. Compara os
 * SHA-256 das duas chaves com `timingSafeEqual` (tamanho fixo, tempo independente do
 * conteúdo). Sem chave configurada, sem cabeçalho ou com chave errada a resposta é a
 * mesma 401, sem revelar o motivo.
 *
 * Credencial temporária e válida para TODOS os clientes; o destino dela fica para as
 * specs 007/008. Não há rate limit até a spec 005 (risco conhecido).
 */
export function adminAuthHook(apiKey: string | undefined): onRequestAsyncHookHandler {
  const expected = apiKey === undefined || apiKey === '' ? undefined : digest(apiKey);
  return (request) => {
    const provided = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const authenticated =
      expected !== undefined &&
      provided !== undefined &&
      timingSafeEqual(digest(provided), expected);
    if (!authenticated) {
      request.log.warn({ path: request.url }, 'acesso administrativo recusado');
      return Promise.reject(new UnauthorizedError());
    }
    return Promise.resolve();
  };
}
