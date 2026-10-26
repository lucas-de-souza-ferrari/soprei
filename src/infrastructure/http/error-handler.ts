import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { BaseError } from '../../shared/errors/index.js';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly { readonly path: string; readonly message: string }[];
  };
}

const INTERNAL_MESSAGE = 'Erro interno do servidor';

function isClientFastifyError(error: unknown): error is FastifyError {
  if (!(error instanceof Error)) return false;
  const { statusCode, code } = error as Partial<FastifyError>;
  return (
    typeof code === 'string' &&
    code.startsWith('FST_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  );
}

function buildBody(
  request: FastifyRequest,
  code: string,
  message: string,
  details?: ErrorBody['error']['details'],
): ErrorBody {
  return { error: { code, message, requestId: request.id, ...(details ? { details } : {}) } };
}

/**
 * Handler central: converte qualquer erro em JSON. A resposta nunca contém stack,
 * `context` nem mensagem de erro 5xx; esses dados vão só para o log.
 */
export function errorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ZodError) {
    request.log.warn({ err: error }, 'entrada inválida');
    const details = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return reply
      .status(400)
      .send(buildBody(request, 'VALIDATION_ERROR', 'Dados inválidos', details));
  }

  if (error instanceof BaseError) {
    const logContext = { err: error, errorContext: error.context };
    if (error.statusCode >= 500) {
      request.log.error(logContext, 'erro de aplicação');
      return reply.status(error.statusCode).send(buildBody(request, error.code, INTERNAL_MESSAGE));
    }
    request.log.warn(logContext, 'erro de aplicação');
    return reply.status(error.statusCode).send(buildBody(request, error.code, error.message));
  }

  if (isClientFastifyError(error)) {
    // Erros do próprio Fastify (JSON malformado, corpo grande demais...): 4xx genérico.
    request.log.warn({ err: error }, 'requisição rejeitada pelo Fastify');
    return reply
      .status(error.statusCode ?? 400)
      .send(buildBody(request, 'BAD_REQUEST', 'Requisição inválida'));
  }

  request.log.error({ err: error }, 'erro inesperado');
  return reply.status(500).send(buildBody(request, 'INTERNAL_ERROR', INTERNAL_MESSAGE));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.status(404).send(buildBody(request, 'NOT_FOUND', 'Rota não encontrada'));
}
