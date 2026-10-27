import { createServer, connect, type Server, type Socket } from 'node:net';

export type ProxyMode = 'forward' | 'blackhole';

/**
 * Proxy TCP de teste entre o client e o Redis, para simular um Redis lento ou fora sem tocar
 * no servidor real: `forward` repassa os bytes; `blackhole` aceita e engole tudo (o comando
 * não recebe resposta: estoura o `commandTimeout`); `stop()` derruba o listener e todas as
 * conexões (Redis "fora": a porta passa a recusar), e `start()` na mesma porta o "religa".
 */
export class ToggleProxy {
  mode: ProxyMode = 'forward';
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  /** Porta de escuta (a mesma entre `stop()` e `start()`, para o client reconectar). */
  get listeningPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    const server = createServer((client) => {
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => undefined);
      const upstream = connect(this.targetPort, this.targetHost);
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('data', (chunk: Buffer) => {
        if (this.mode === 'forward') upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => {
        if (this.mode === 'forward') client.write(chunk);
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('proxy sem porta');
    this.port = address.port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
