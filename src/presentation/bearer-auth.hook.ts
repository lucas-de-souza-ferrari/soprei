import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { UnauthorizedError } from '../shared/errors/index.js';

const BEARER = /^Bearer (\S+)$/i;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Autenticação por `Authorization: Bearer <token>` com um token estático. Compara os
 * SHA-256 dos dois com `timingSafeEqual` (tamanho fixo, tempo independente do conteúdo).
 * Sem token configurado, sem cabeçalho ou com token errado a resposta é a mesma 401, sem
 * revelar o motivo. `onRejected` deixa cada rota registrar a recusa com o seu contexto
 * (nunca o token).
 */
export function bearerAuthHook(
  token: string | undefined,
  onRejected?: (request: FastifyRequest) => void,
): onRequestAsyncHookHandler {
  const expected = token === undefined || token === '' ? undefined : digest(token);
  return (request) => {
    const provided = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const authenticated =
      expected !== undefined &&
      provided !== undefined &&
      timingSafeEqual(digest(provided), expected);
    if (!authenticated) {
      onRejected?.(request);
      return Promise.reject(new UnauthorizedError());
    }
    return Promise.resolve();
  };
}
