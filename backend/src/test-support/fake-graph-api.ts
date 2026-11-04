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
  /** Operação reconhecida (spec 015): `messages`, `debug_token`, `phone_numbers`, `subscribe`, `unsubscribe`. */
  readonly operation: GraphOperation | undefined;
  /** Parâmetros da query string (o `input_token` do `debug_token` vem aqui). */
  readonly query: Readonly<Record<string, string>>;
}

export type GraphOperation =
  | 'messages'
  | 'debug_token'
  | 'phone_numbers'
  | 'subscribe'
  | 'unsubscribe'
  | 'oauth_token'
  | 'register';

/** Um token que o servidor falso conhece (spec 015). */
export interface FakeToken {
  readonly appId: string;
  readonly scopes: readonly string[];
  /** WABAs que o token enxerga (e que aparecem em `granular_scopes.target_ids`). */
  readonly wabaIds: readonly string[];
  readonly valid?: boolean;
  /** Epoch em segundos; 0 ou ausente = não expira. */
  readonly expiresAt?: number;
  /** Se `false`, o `debug_token` não devolve `granular_scopes`. */
  readonly granular?: boolean;
}

export const FULL_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'] as const;

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
  /** Responde com `status` e despeja corpo sem fim (em pedaços de 16 KiB) até a empresa fechar. */
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
  private readonly tokens = new Map<string, FakeToken>();
  private readonly wabas = new Map<string, string[]>();
  private readonly operationScripts = new Map<GraphOperation, GraphBehavior[]>();
  /** Token de app esperado no `debug_token` (`app_id|app_secret`); se definido, outro valor é recusado. */
  expectedAppToken: string | undefined;
  /** `code` do Embedded Signup (spec 015b): uso único, expirável. */
  private readonly codes = new Map<string, { token: string; used: boolean; expired: boolean }>();
  /** `client_id` e `client_secret` esperados na troca do `code`; se definido, outro valor é recusado. */
  expectedApp: { readonly id: string; readonly secret: string } | undefined;
  /** PIN com que cada número já está registrado (`null` = não registrado). */
  readonly registeredPins = new Map<string, string | null>();
  /** WABAs com o app assinado (`subscribed_apps`). */
  readonly subscribed = new Set<string>();
  /** Bytes que o modo `flood` escreveu e se a empresa fechou a conexão antes do fim do teste. */
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
        const url = new URL(path, 'http://fake.local');
        const query = Object.fromEntries(url.searchParams.entries());
        const operation = operationOf(request.method ?? '', url.pathname);
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
          operation,
          query,
        });
        const behavior =
          (operation === undefined ? undefined : this.operationScripts.get(operation)?.shift()) ??
          this.scripted.shift() ??
          this.fallback ??
          this.channelBehavior(
            operation,
            url.pathname,
            request.headers.authorization,
            query,
            body,
          ) ??
          this.success();
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

  /** Registra um `code` do Embedded Signup que, trocado, devolve `token` (uso único). */
  addCode(code: string, token: string, options: { expired?: boolean } = {}): void {
    this.codes.set(code, { token, used: false, expired: options.expired ?? false });
  }

  /** Marca o número como já registrado com `pin` (2FA), para provar o erro de PIN diferente. */
  setRegistered(phoneNumberId: string, pin: string | null): void {
    this.registeredPins.set(phoneNumberId, pin);
  }

  /** Registra um token que o `debug_token` e as consultas com `Authorization: Bearer <token>` reconhecem. */
  addToken(token: string, info: FakeToken): void {
    this.tokens.set(token, info);
  }

  /** Números (`phone_number_id`) de uma WABA, devolvidos por `GET /{waba}/phone_numbers`. */
  addWaba(wabaId: string, phoneNumberIds: readonly string[]): void {
    this.wabas.set(wabaId, [...phoneNumberIds]);
  }

  /** Os próximos `count` pedidos da `operation` recebem `behavior` (antes de qualquer outro roteiro). */
  failOperation(operation: GraphOperation, behavior: GraphBehavior, count = 1): void {
    const list = this.operationScripts.get(operation) ?? [];
    for (let i = 0; i < count; i += 1) list.push(behavior);
    this.operationScripts.set(operation, list);
  }

  /** Pedidos de uma operação, na ordem. */
  ofOperation(operation: GraphOperation): GraphRequest[] {
    return this.requests.filter((request) => request.operation === operation);
  }

  /** O par (`Authorization`, número) de cada envio de mensagem, para provar o isolamento de token. */
  sendPairs(): { authorization: string | undefined; phoneNumberId: string | undefined }[] {
    return this.ofOperation('messages').map((request) => ({
      authorization: request.headers.authorization,
      phoneNumberId: request.phoneNumberId,
    }));
  }

  /** Comportamento de administração do canal (spec 015); `undefined` = não é uma operação dela. */
  private channelBehavior(
    operation: GraphOperation | undefined,
    pathname: string,
    authorization: string | undefined,
    query: Readonly<Record<string, string>>,
    body: unknown,
  ): GraphBehavior | undefined {
    const bearer = authorization?.replace(/^Bearer /, '');
    // O corpo de erro ECOA o token de propósito: a empresa nunca pode repassá-lo.
    const echo = `eco: ${authorization ?? ''} ${query.input_token ?? ''} ${query.client_secret ?? ''} ${query.code ?? ''} ${JSON.stringify(body ?? '')}`;
    const fail = (status: number, code: number): GraphBehavior => ({
      kind: 'respond',
      status,
      body: { error: { message: echo, type: 'OAuthException', code } },
    });
    if (operation === 'oauth_token') {
      if (
        this.expectedApp !== undefined &&
        (query.client_id !== this.expectedApp.id ||
          query.client_secret !== this.expectedApp.secret)
      ) {
        return fail(400, 101);
      }
      const entry = this.codes.get(query.code ?? '');
      if (entry === undefined || entry.used || entry.expired) return fail(400, 100);
      entry.used = true;
      return {
        kind: 'respond',
        status: 200,
        body: { access_token: entry.token, token_type: 'bearer' },
      };
    }
    if (operation === 'register') {
      const info = this.tokens.get(bearer ?? '');
      if (info === undefined || info.valid === false) return fail(401, 190);
      const phone = pathname.split('/')[2] ?? '';
      const pin = (body as { pin?: unknown } | undefined)?.pin;
      if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) return fail(400, 100);
      const current = this.registeredPins.get(phone) ?? null;
      // Número com verificação em duas etapas e outro PIN: a Meta recusa (133005).
      if (current !== null && current !== pin) return fail(400, 133005);
      this.registeredPins.set(phone, pin);
      return { kind: 'respond', status: 200, body: { success: true } };
    }
    if (operation === 'debug_token') {
      if (this.expectedAppToken !== undefined && bearer !== this.expectedAppToken) {
        return fail(400, 190);
      }
      const info = this.tokens.get(query.input_token ?? '');
      if (info === undefined) {
        return {
          kind: 'respond',
          status: 200,
          body: { data: { is_valid: false, error: { code: 190 } } },
        };
      }
      return {
        kind: 'respond',
        status: 200,
        body: {
          data: {
            is_valid: info.valid ?? true,
            app_id: info.appId,
            scopes: info.scopes,
            ...(info.granular === false
              ? {}
              : {
                  granular_scopes: info.scopes.map((scope) => ({
                    scope,
                    target_ids: info.wabaIds,
                  })),
                }),
            expires_at: info.expiresAt ?? 0,
          },
        },
      };
    }
    if (operation === 'phone_numbers' || operation === 'subscribe' || operation === 'unsubscribe') {
      const wabaId = pathname.split('/')[2] ?? '';
      const info = this.tokens.get(bearer ?? '');
      if (info === undefined || info.valid === false) return fail(401, 190);
      if (!info.wabaIds.includes(wabaId)) return fail(400, 100);
      if (operation === 'phone_numbers') {
        const ids = this.wabas.get(wabaId) ?? [];
        return { kind: 'respond', status: 200, body: { data: ids.map((id) => ({ id })) } };
      }
      if (operation === 'subscribe') this.subscribed.add(wabaId);
      else this.subscribed.delete(wabaId);
      return { kind: 'respond', status: 200, body: { success: true } };
    }
    return undefined;
  }

  reset(): void {
    this.tokens.clear();
    this.wabas.clear();
    this.operationScripts.clear();
    this.subscribed.clear();
    this.codes.clear();
    this.registeredPins.clear();
    this.expectedApp = undefined;
    this.expectedAppToken = undefined;
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

function operationOf(method: string, pathname: string): GraphOperation | undefined {
  if (method === 'GET' && /^\/[^/]+\/oauth\/access_token$/.test(pathname)) return 'oauth_token';
  if (method === 'POST' && /^\/[^/]+\/[^/]+\/register$/.test(pathname)) return 'register';
  if (method === 'POST' && /^\/[^/]+\/[^/]+\/messages$/.test(pathname)) return 'messages';
  if (method === 'GET' && /^\/[^/]+\/debug_token$/.test(pathname)) return 'debug_token';
  if (method === 'GET' && /^\/[^/]+\/[^/]+\/phone_numbers$/.test(pathname)) {
    return 'phone_numbers';
  }
  if (/^\/[^/]+\/[^/]+\/subscribed_apps$/.test(pathname)) {
    if (method === 'POST') return 'subscribe';
    if (method === 'DELETE') return 'unsubscribe';
  }
  return undefined;
}
