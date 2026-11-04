import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

export interface AnthropicRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** Corpo cru do pedido. */
  readonly raw: string;
  /** Corpo JSON interpretado (ou `undefined` se não era JSON). */
  readonly body: Record<string, unknown> | undefined;
}

export type FakeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature?: string };

/** Como o servidor responde a um pedido. */
export type AnthropicBehavior =
  | {
      readonly kind: 'message';
      readonly content?: readonly FakeContentBlock[];
      readonly stopReason?: string | null;
      readonly usage?: {
        readonly input_tokens: number;
        readonly output_tokens: number;
        readonly cache_read_input_tokens?: number;
      };
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'error';
      readonly status: number;
      /** `error.type` do corpo (a API devolve `rate_limit_error`, `overloaded_error`...). */
      readonly errorType?: string;
      /** Como a API às vezes faz: o corpo do erro cita o pedido (texto de contato, histórico, persona). */
      readonly echoRequest?: boolean;
      /** `retry-after-ms` enviado (padrão 5): valor longo mantém o SDK dormindo entre as tentativas. */
      readonly retryAfterMs?: number;
    }
  /** Aceita a conexão e nunca responde (para testar cancelamento). */
  | { readonly kind: 'hang' }
  /** Derruba a conexão sem responder (erro de rede). */
  | { readonly kind: 'drop' }
  /** Responde com redirecionamento (o SDK/fetch não deve seguir e reenviar o corpo). */
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string };

export const textMessage = (
  text: string,
  extra: Partial<AnthropicBehavior> = {},
): AnthropicBehavior =>
  ({
    kind: 'message',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 5 },
    ...extra,
  }) as AnthropicBehavior;

/**
 * Servidor falso da API de mensagens da Anthropic (`POST /v1/messages`), local (`node:http`, porta
 * 0): registra cada pedido, responde com sucesso por padrão e aceita comportamentos enfileirados
 * (`script`, `always`). Conta as conexões que o cliente encerrou antes da resposta (cancelamento).
 */
export class FakeAnthropicApi {
  readonly requests: AnthropicRequest[] = [];
  /** Quantas respostas a empresa deixou de esperar (conexão fechada antes do fim da resposta). */
  clientClosedCount = 0;
  private server: Server | undefined;
  private scripted: AnthropicBehavior[] = [];
  private fallback: AnthropicBehavior | undefined;
  private baseUrlValue = '';
  private closeWaiters: (() => void)[] = [];

  /** `http://127.0.0.1:<porta>`, depois de `start()`. */
  get baseUrl(): string {
    return this.baseUrlValue;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> | undefined;
        try {
          body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          body = undefined;
        }
        this.requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          raw,
          body,
        });
        response.on('close', () => {
          if (!response.writableEnded) {
            this.clientClosedCount += 1;
            const waiters = this.closeWaiters;
            this.closeWaiters = [];
            for (const waiter of waiters) waiter();
          }
        });
        const behavior =
          this.scripted.shift() ?? this.fallback ?? textMessage('Resposta do modelo falso.');
        this.respond(behavior, raw, request.socket, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('porta indisponível');
    this.baseUrlValue = `http://127.0.0.1:${String(address.port)}`;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** Respostas, uma por pedido, na ordem; esgotadas, volta ao comportamento padrão. */
  script(...behaviors: AnthropicBehavior[]): void {
    this.scripted.push(...behaviors);
  }

  /** Todo pedido recebe `behavior` (até `reset()`), depois do que já está enfileirado. */
  always(behavior: AnthropicBehavior): void {
    this.fallback = behavior;
  }

  reset(): void {
    this.scripted = [];
    this.fallback = undefined;
    this.requests.length = 0;
    this.clientClosedCount = 0;
  }

  /** Espera (com prazo) até a empresa ter fechado pelo menos `count` conexões antes da resposta. */
  async waitForClientClose(count = 1, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.clientClosedCount < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.closeWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  private respond(
    behavior: AnthropicBehavior,
    raw: string,
    socket: { destroy(): void },
    response: ServerResponse,
  ): void {
    if (behavior.kind === 'hang') return;
    if (behavior.kind === 'drop') {
      socket.destroy();
      return;
    }
    if (behavior.kind === 'redirect') {
      response.writeHead(behavior.status, { location: behavior.location });
      response.end();
      return;
    }
    if (behavior.kind === 'error') {
      const message = behavior.echoRequest === true ? `pedido recebido: ${raw}` : 'erro simulado';
      // O SDK respeita `retry-after-ms`: a repetição sai em milissegundos, não em segundos.
      response.writeHead(behavior.status, {
        'content-type': 'application/json',
        'retry-after-ms': String(behavior.retryAfterMs ?? 5),
      });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: behavior.errorType ?? 'api_error', message },
          request_id: 'req_fake',
        }),
      );
      return;
    }
    const send = (): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: behavior.content ?? [{ type: 'text', text: 'Resposta do modelo falso.' }],
          stop_reason: behavior.stopReason === undefined ? 'end_turn' : behavior.stopReason,
          stop_sequence: null,
          usage: behavior.usage ?? { input_tokens: 10, output_tokens: 5 },
        }),
      );
    };
    if (behavior.delayMs === undefined) send();
    else setTimeout(send, behavior.delayMs);
  }
}
