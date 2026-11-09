import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Uma chamada recebida pelo servidor falso (para as asserções dos testes). */
export interface FakeInfinitepayCall {
  readonly path: string;
  readonly apiKey: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface FakePayment {
  /** Valor do link (amount); o que o servidor confere com o pedido. */
  readonly amount: number;
  /** Valor pago (pode ser maior: taxas de parcelamento repassadas). */
  readonly paidAmount?: number;
  readonly captureMethod?: string;
}

type Failure =
  | { readonly kind: 'status'; readonly status: number; readonly retryAfter?: string }
  | { readonly kind: 'slow'; readonly ms: number }
  | { readonly kind: 'drop' }
  | { readonly kind: 'echo' };

/**
 * Servidor falso da InfinitePay (spec 031, E3): node:http na porta 0, sem rede externa e sem chave real.
 * POST /links cria um link; POST /payment_check responde pelo que o teste marcou como pago. Exige o
 * X-Api-Key combinado (senão 403, como a documentação descreve) e registra cada chamada. As falhas sob
 * comando incluem o modo "echo", que ecoa a chave, o corpo e o link na resposta de erro para provar que
 * nada disso vaza para log, métrica, erro nem resposta.
 */
export class FakeInfinitepayApi {
  readonly calls: FakeInfinitepayCall[] = [];
  private server: Server | undefined;
  private readonly payments = new Map<string, FakePayment>();
  private linkFailure: Failure | undefined;
  private checkFailure: Failure | undefined;
  private checkFailuresLeft = Number.POSITIVE_INFINITY;
  private linkResponse: unknown;

  constructor(readonly apiKey: string) {}

  get baseUrl(): string {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined) throw new Error('servidor falso não iniciado');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    const server = this.server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    this.server = undefined;
  }

  /** Marca o pedido como pago no provedor (o payment_check passa a responder pago). */
  markPaid(orderId: string, payment: FakePayment): void {
    this.payments.set(orderId, payment);
  }

  /** Falha do POST /links sob comando (undefined limpa). */
  failLinks(failure: Failure | undefined): void {
    this.linkFailure = failure;
  }

  /** Falha do POST /payment_check sob comando (undefined limpa). */
  failChecks(failure: Failure | undefined, times = Number.POSITIVE_INFINITY): void {
    this.checkFailure = failure;
    this.checkFailuresLeft = times;
  }

  /** Corpo de sucesso do POST /links diferente do padrão (formato inesperado, link malicioso...). */
  setLinkResponse(body: unknown): void {
    this.linkResponse = body;
  }

  callsTo(path: string): readonly FakeInfinitepayCall[] {
    return this.calls.filter((call) => call.path === path);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = parseBody(Buffer.concat(chunks).toString('utf8'));
    const path = (request.url ?? '').split('?')[0] ?? '';
    const header = request.headers['x-api-key'];
    const apiKey = typeof header === 'string' ? header : undefined;
    this.calls.push({ path, apiKey, body });

    if (request.method !== 'POST') {
      send(response, 404, {});
    } else if (apiKey !== this.apiKey) {
      send(response, 403, { message: 'forbidden' });
    } else if (path === '/links') {
      await this.links(body, response, request.headers.host ?? '127.0.0.1');
    } else if (path === '/payment_check') {
      await this.paymentCheck(body, response);
    } else {
      send(response, 404, {});
    }
  }

  private async links(
    body: Record<string, unknown>,
    response: ServerResponse,
    host: string,
  ): Promise<void> {
    if (await this.applyFailure(this.linkFailure, body, response)) return;
    const orderId = typeof body.order_nsu === 'string' ? body.order_nsu : 'sem-pedido';
    send(
      response,
      200,
      this.linkResponse ?? { url: `http://${host}/pay/${encodeURIComponent(orderId)}` },
    );
  }

  private async paymentCheck(
    body: Record<string, unknown>,
    response: ServerResponse,
  ): Promise<void> {
    if (this.checkFailuresLeft > 0) {
      if (this.checkFailure !== undefined) this.checkFailuresLeft -= 1;
      if (await this.applyFailure(this.checkFailure, body, response)) return;
    }
    const orderId = typeof body.order_nsu === 'string' ? body.order_nsu : '';
    const payment = this.payments.get(orderId);
    if (payment === undefined) {
      send(response, 200, { success: true, paid: false });
      return;
    }
    send(response, 200, {
      success: true,
      paid: true,
      amount: payment.amount,
      paid_amount: payment.paidAmount ?? payment.amount,
      installments: 1,
      capture_method: payment.captureMethod ?? 'pix',
    });
  }

  /** Devolve true se a falha respondeu (ou derrubou) a requisição. */
  private async applyFailure(
    failure: Failure | undefined,
    body: Record<string, unknown>,
    response: ServerResponse,
  ): Promise<boolean> {
    if (failure === undefined) return false;
    switch (failure.kind) {
      case 'status':
        send(response, failure.status, { message: 'falha' }, failure.retryAfter);
        return true;
      case 'slow':
        await new Promise((resolve) => setTimeout(resolve, failure.ms));
        return false;
      case 'drop':
        response.destroy();
        return true;
      case 'echo':
        // Erro que ecoa a chave, o link e o corpo do pedido (pagador incluído), de propósito.
        send(response, 500, {
          message: `erro com chave ${this.apiKey} e corpo ${JSON.stringify(body)}`,
          receipt_url: 'https://recibo.exemplo/echo',
          url: 'https://checkout.exemplo/echo',
        });
        return true;
    }
  }
}

function parseBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function send(response: ServerResponse, status: number, body: unknown, retryAfter?: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
  });
  response.end(JSON.stringify(body));
}
