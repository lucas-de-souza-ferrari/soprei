import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { ValidationError } from '../../shared/errors/index.js';
import { buildPageQuery, decodeCursor, encodeCursor, resolveLimit, toPage } from './cursor.js';

describe('cursor', () => {
  it('codifica e decodifica a posição sem perder precisão', () => {
    const position = { createdAt: new Date('2026-03-04T05:06:07.089Z'), id: randomUUID() };
    const decoded = decodeCursor(encodeCursor(position));
    assert.equal(decoded.createdAt.getTime(), position.createdAt.getTime());
    assert.equal(decoded.id, position.id);
  });

  it('é opaco: não deixa ver o id em texto puro', () => {
    const id = randomUUID();
    assert.ok(!encodeCursor({ createdAt: new Date(), id }).includes(id));
  });

  const base64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const [label, cursor] of [
    ['texto aleatório', 'isto-nao-e-cursor'],
    ['vazio', ''],
    ['JSON que não é a tupla', base64({ a: 1 })],
    ['data inválida', base64(['ontem', randomUUID()])],
    ['data fora do formato ISO', base64(['2026-03-04', randomUUID()])],
    ['id que não é UUID', base64(['2026-03-04T05:06:07.089Z', 'abc'])],
    ['tupla com 3 itens', base64(['2026-03-04T05:06:07.089Z', randomUUID(), 1])],
  ] as const) {
    it(`rejeita cursor inválido (${label}) com ValidationError`, () => {
      assert.throws(() => decodeCursor(cursor), ValidationError);
    });
  }
});

describe('resolveLimit', () => {
  it('usa 50 por padrão e aceita de 1 a 200', () => {
    assert.equal(resolveLimit(undefined), 50);
    assert.equal(resolveLimit(1), 1);
    assert.equal(resolveLimit(200), 200);
  });

  it('rejeita fora do intervalo ou não inteiro com ValidationError', () => {
    for (const value of [0, -1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => resolveLimit(value), ValidationError, String(value));
    }
  });
});

describe('buildPageQuery e toPage', () => {
  it('busca uma linha a mais que o limite', () => {
    assert.equal(buildPageQuery({ limit: 10 }).take, 11);
    assert.equal(buildPageQuery(undefined).take, 51);
  });

  it('o cursor vira a condição "depois de (createdAt, id)"', () => {
    const position = { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: randomUUID() };
    const { after } = buildPageQuery({ cursor: encodeCursor(position) });
    assert.deepEqual(after, [
      { createdAt: { gt: position.createdAt } },
      { createdAt: position.createdAt, id: { gt: position.id } },
    ]);
  });

  it('cursor inválido na consulta vira ValidationError', () => {
    assert.throws(() => buildPageQuery({ cursor: 'xxx' }), ValidationError);
  });

  it('só há nextCursor quando sobra linha além do limite', () => {
    const rows = [1, 2, 3].map((n) => ({
      id: randomUUID(),
      createdAt: new Date(2026, 0, n),
    }));
    const full = toPage(rows, 2, (row) => row.id);
    assert.equal(full.items.length, 2);
    assert.ok(full.nextCursor !== null);
    const last = decodeCursor(full.nextCursor);
    assert.equal(last.id, rows[1]?.id);

    const exact = toPage(rows.slice(0, 2), 2, (row) => row.id);
    assert.equal(exact.nextCursor, null);
    assert.deepEqual(
      toPage([], 2, (row: { id: string; createdAt: Date }) => row.id),
      {
        items: [],
        nextCursor: null,
      },
    );
  });
});
