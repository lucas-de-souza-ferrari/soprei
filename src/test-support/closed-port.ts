import { createServer } from 'node:net';

/** Porta em localhost em que (praticamente com certeza) ninguém está escutando. */
export async function getClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('não foi possível reservar uma porta');
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
}

/** Troca a porta de uma URL (postgresql:// ou redis://), preservando o resto. */
export function withPort(rawUrl: string, port: number): string {
  const url = new URL(rawUrl);
  url.port = String(port);
  return url.toString();
}
