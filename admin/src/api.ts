import { z } from 'zod';

/**
 * Acesso à API do admin (spec 044, E3). Tudo vai a `/api/platform/*` na mesma origem (o nginx, e o proxy
 * do Vite em desenvolvimento, tiram o `/api`), com o cookie `HttpOnly` da sessão, que o JavaScript nunca
 * vê. Toda chamada leva `X-Soprei-App: admin`; nas escritas o navegador manda o `Origin` da página, que o
 * servidor compara com `ADMIN_ORIGIN`.
 *
 * O texto de erro do servidor nunca é lido: só o `status` e o `error.code` (identificador fixo). A
 * mensagem da tela sai de `errorMessage` (format.ts).
 */
export class ApiError extends Error {
  constructor(
    /** Status HTTP, ou 0 para falha de rede e resposta fora do contrato. */
    readonly status: number,
    /** `error.code` do servidor, `NETWORK` ou `INVALID_RESPONSE`; `undefined` se não veio. */
    readonly code?: string,
  ) {
    super(`HTTP ${String(status)}${code === undefined ? '' : ` ${code}`}`);
  }
}

const errorBodySchema = z.object({
  error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) }),
});

async function codeOf(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

type Fetch = typeof fetch;

export interface ApiClient {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  post(path: string, body?: unknown): Promise<void>;
  /** `POST` cuja resposta interessa (spec 045, E3b: "Nova empresa" devolve o id): conferida pelo contrato. */
  postFor<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
}

/** Cliente da API; `fetchImpl` existe para os testes unitários. */
export function createApi(fetchImpl: Fetch = (...args) => fetch(...args)): ApiClient {
  async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`/api${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Soprei-App': 'admin',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }
    if (!response.ok) throw new ApiError(response.status, await codeOf(response));
    return response;
  }

  async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(0, 'INVALID_RESPONSE');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError(0, 'INVALID_RESPONSE');
    return parsed.data;
  }

  return {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
      return parse(await send('GET', path), schema);
    },
    async post(path: string, body?: unknown): Promise<void> {
      await send('POST', path, body);
    },
    async postFor<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
      return parse(await send('POST', path, body), schema);
    },
  };
}

/** Monta a query string só com os valores definidos e não vazios. */
export function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(key, value);
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}
