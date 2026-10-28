import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface GraphRequest {
  readonly method: string;
  readonly path: string;
  /** Segmentos do caminho `/<versão>/<phone_number_id>/messages`, quando casam. */
  readonly version: string | undefined;
  readonly phoneNumberId: string | undefined;
  readonly headers: IncomingHttpHeaders;
  /** Corpo JSON interpretado (ou `undefined` se não era JSON). */
  readonly body: unknown;
}

/** Como o servidor responde a um pedido. */
export type GraphBehavior =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly body?: unknown;
      readonly delayMs?: number;
    }
  /** Aceita a conexão e nunca responde (para testar timeout). */
  | { readonly kind: 'hang' }
  /** Derruba a conexão sem responder (erro de rede). */
  | { readonly kind: 'drop' }
  /** Responde com `status` e despeja corpo sem fim (em pedaços de 16 KiB) até o cliente fechar. */
  | { readonly kind: 'flood'; readonly status: number };

export const graphError = (
  status: number,
  code: number,
  type = 'OAuthException',
): GraphBehavior => ({
  kind: 'respond',
  status,
  body: {
    error: { message: `(#${String(code)}) texto da Meta com o número 5511999990000`, type, code },
  },
});

/**
 * Servidor Graph API falso, local (`node:http`, porta 0), para os testes do envio: registra cada
 * requisição e responde com sucesso (`wamid.FAKE<n>`), a não ser que um comportamento tenha sido
 * enfileirado (`failNext`, `script`) ou o servidor esteja em modo `always`.
 */
export class FakeGraphApi {
  readonly requests: GraphRequest[] = [];
  private server: Server | undefined;
  private sequence = 0;
  private scripted: GraphBehavior[] = [];
  private fallback: GraphBehavior | undefined;
  private baseUrlValue = '';
  /** Bytes que o modo `flood` escreveu e se o cliente fechou a conexão antes do fim do teste. */
  floodBytesWritten = 0;
  floodClosedByClient = false;

  /** Quantos pedidos receberam a resposta de sucesso padrão (cada um com um `wamid.FAKE<n>` novo). */
  get successCount(): number {
    return this.sequence;
  }

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
        const path = request.url ?? '';
        const match = /^\/([^/]+)\/([^/]+)\/messages$/.exec(path);
        let body: unknown;
        try {
          body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        } catch {
          body = undefined;
        }
        this.requests.push({
          method: request.method ?? '',
          path,
          version: match?.[1],
          phoneNumberId: match?.[2],
          headers: request.headers,
          body,
        });
        const behavior = this.scripted.shift() ?? this.fallback ?? this.success();
        if (behavior.kind === 'hang') return;
        if (behavior.kind === 'flood') {
          response.writeHead(behavior.status, { 'content-type': 'application/json' });
          const chunk = Buffer.alloc(16 * 1024, 0x20);
          let open = true;
          response.on('close', () => {
            open = false;
            this.floodClosedByClient = true;
          });
          const pump = (): void => {
            while (open) {
              this.floodBytesWritten += chunk.length;
              if (!response.write(chunk)) {
                response.once('drain', pump);
                return;
              }
            }
          };
          pump();
          return;
        }
        if (behavior.kind === 'drop') {
          request.socket.destroy();
          return;
        }
        const send = (): void => {
          response.writeHead(behavior.status, { 'content-type': 'application/json' });
          response.end(behavior.body === undefined ? '' : JSON.stringify(behavior.body));
        };
        if (behavior.delayMs === undefined) send();
        else setTimeout(send, behavior.delayMs);
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

  /** Os próximos `count` pedidos recebem `behavior`; depois volta ao comportamento padrão. */
  failNext(count: number, behavior: GraphBehavior): void {
    for (let i = 0; i < count; i += 1) this.scripted.push(behavior);
  }

  /** Respostas, uma por pedido, na ordem; esgotadas, volta ao comportamento padrão. */
  script(...behaviors: GraphBehavior[]): void {
    this.scripted.push(...behaviors);
  }

  /** Todo pedido recebe `behavior` (até `reset()`), depois do que já está enfileirado. */
  always(behavior: GraphBehavior): void {
    this.fallback = behavior;
  }

  reset(): void {
    this.scripted = [];
    this.fallback = undefined;
    this.requests.length = 0;
    this.sequence = 0;
    this.floodBytesWritten = 0;
    this.floodClosedByClient = false;
  }

  /** Pedidos que o servidor respondeu com sucesso por padrão não são distinguíveis; use `requests`. */
  private success(): GraphBehavior {
    this.sequence += 1;
    return {
      kind: 'respond',
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: 'x', wa_id: 'x' }],
        messages: [{ id: `wamid.FAKE${String(this.sequence)}` }],
      },
    };
  }
}
