import { z } from 'zod';

/**
 * Acesso à API do site (spec 017, ampliado na 023). O site chama `/api/*` com o cookie `HttpOnly`
 * da sessão e o cabeçalho `X-Soprei-App: web`; nenhum token fica no navegador.
 *
 * O texto de erro do servidor **nunca** é lido nem mostrado: só o `status` e, quando existe, o
 * `error.code` (identificador fixo, como `CHANNEL_NUMBER_IN_USE`). As mensagens da tela são escolhidas
 * pelo site a partir desses dois valores.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `error.code` do corpo de erro: só o formato de um identificador fixo (nada de texto livre). */
const errorBodySchema = z.object({
  error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) }),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** `error.code` do servidor, ou `undefined` (corpo ausente, inválido ou sem código). */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  /** Mensagem usada para o 401 (padrão: entrar de novo). */
  readonly unauthorized?: string;
}

async function codeOf(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** Mensagem genérica por status, para as telas de conta (login, cadastro, empresas). */
function accountMessage(status: number, unauthorized: string | undefined): string {
  if (status === 401) return unauthorized ?? 'Entre novamente ou confira suas credenciais.';
  if (status === 403) return 'Confirme seu e-mail ou confira seu acesso.';
  if (status === 429) return 'Muitas tentativas. Aguarde antes de tentar novamente.';
  return 'Não foi possível concluir. Tente novamente mais tarde.';
}

export async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const { method = 'GET', body, unauthorized } = options;
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Soprei-App': 'web',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      accountMessage(response.status, unauthorized),
      await codeOf(response),
    );
  }
  return response.status === 204 ? undefined : response.json();
}

/** Atalho das telas de conta: GET sem corpo, POST com corpo (comportamento anterior à spec 023). */
export function api(path: string, body?: unknown, unauthorized?: string): Promise<unknown> {
  return request(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body }),
    ...(unauthorized === undefined ? {} : { unauthorized }),
  });
}
