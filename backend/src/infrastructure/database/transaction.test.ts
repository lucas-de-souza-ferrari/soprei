import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../../generated/prisma/client.js';
import { backoffDelayMs, retryOnRecoverable } from './transaction.js';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('falha', { code, clientVersion: 'test' });
}

describe('retryOnRecoverable', () => {
  it('repete em P2034 com backoff exponencial e devolve o sucesso', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await retryOnRecoverable(
      () => {
        attempts++;
        if (attempts < 3) return Promise.reject(prismaError('P2034'));
        return Promise.resolve('ok');
      },
      {
        baseDelayMs: 100,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );

    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
    assert.equal(delays.length, 2);
    // 100ms e 200ms, mais até 25% de jitter.
    assert.ok(delays[0] !== undefined && delays[0] >= 100 && delays[0] <= 125);
    assert.ok(delays[1] !== undefined && delays[1] >= 200 && delays[1] <= 250);
  });

  it('repete em P2028', async () => {
    let attempts = 0;
    await retryOnRecoverable(
      () => {
        attempts++;
        return attempts === 1 ? Promise.reject(prismaError('P2028')) : Promise.resolve();
      },
      { sleep: () => Promise.resolve() },
    );
    assert.equal(attempts, 2);
  });

  it('não repete erro não recuperável', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOnRecoverable(
        () => {
          attempts++;
          return Promise.reject(prismaError('P2002'));
        },
        { sleep: () => Promise.resolve() },
      ),
    );
    assert.equal(attempts, 1);
  });

  it('desiste depois de maxRetries e relança o erro recuperável', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOnRecoverable(
        () => {
          attempts++;
          return Promise.reject(prismaError('P2034'));
        },
        { maxRetries: 2, sleep: () => Promise.resolve() },
      ),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034',
    );
    assert.equal(attempts, 3);
  });
});

describe('backoffDelayMs', () => {
  it('dobra a cada tentativa e respeita o teto', () => {
    assert.ok(backoffDelayMs(0, 50, 2_000) >= 50);
    assert.ok(backoffDelayMs(3, 50, 2_000) >= 400);
    assert.ok(backoffDelayMs(20, 50, 2_000) <= 2_500);
  });
});
