import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newPasswordSchema } from '../../application/auth/credentials.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import {
  DEFAULT_SCRYPT_COST,
  MAX_CONCURRENT_HASHES,
  MAX_QUEUED_ADMIN_HASHES,
  MAX_QUEUED_HASHES,
  type ScryptDerive,
  ScryptPasswordHasher,
} from './scrypt-password-hasher.js';

/** Custo baixo: os testes não pagam 128 MiB por hash. */
const LOW = { N: 1024, r: 8, p: 1 } as const;
const PASSWORD = 'uma-senha-de-teste-bem-longa';

describe('ScryptPasswordHasher', () => {
  it('hash e verify conferem; senha diferente não confere', async () => {
    const hasher = new ScryptPasswordHasher({ cost: LOW });
    const stored = await hasher.hash(PASSWORD);
    assert.equal(await hasher.verify(PASSWORD, stored), true);
    assert.equal(await hasher.verify(`${PASSWORD}x`, stored), false);
    assert.equal(await hasher.verify('', stored), false);
  });

  it('sal diferente por hash: a mesma senha gera valores diferentes', async () => {
    const hasher = new ScryptPasswordHasher({ cost: LOW });
    const [a, b] = [await hasher.hash(PASSWORD), await hasher.hash(PASSWORD)];
    assert.notEqual(a, b);
    assert.equal(await hasher.verify(PASSWORD, a), true);
    assert.equal(await hasher.verify(PASSWORD, b), true);
  });

  it('formato scrypt$N$r$p$<sal b64>$<hash b64> com sal de 16 bytes e chave de 32', async () => {
    const hasher = new ScryptPasswordHasher({ cost: LOW });
    const stored = await hasher.hash(PASSWORD);
    const parts = stored.split('$');
    assert.equal(parts.length, 6);
    assert.deepEqual(parts.slice(0, 4), ['scrypt', '1024', '8', '1']);
    assert.equal(Buffer.from(parts[4] ?? '', 'base64').length, 16);
    assert.equal(Buffer.from(parts[5] ?? '', 'base64').length, 32);
    assert.ok(!stored.includes(PASSWORD));
  });

  it('o custo padrão é o da OWASP (N = 2^17, r = 8, p = 1) e vai no próprio valor', async () => {
    assert.deepEqual(DEFAULT_SCRYPT_COST, { N: 131072, r: 8, p: 1 });
    const hasher = new ScryptPasswordHasher();
    const stored = await hasher.hash(PASSWORD);
    assert.ok(stored.startsWith('scrypt$131072$8$1$'));
    assert.equal(await hasher.verify(PASSWORD, stored), true);
  });

  it('verifica hash de outro custo (os parâmetros vêm do valor guardado)', async () => {
    const old = await new ScryptPasswordHasher({ cost: LOW }).hash(PASSWORD);
    const stricter = new ScryptPasswordHasher({ cost: { N: 2048, r: 8, p: 1 } });
    assert.equal(await stricter.verify(PASSWORD, old), true);
  });

  it('hash malformado ou com parâmetros fora do aceito falha como inválido, sem lançar', async () => {
    const hasher = new ScryptPasswordHasher({ cost: LOW });
    const good = (await hasher.hash(PASSWORD)).split('$');
    const salt = good[4] ?? '';
    const key = good[5] ?? '';
    const malformed = [
      '',
      'scrypt',
      `bcrypt$1024$8$1$${salt}$${key}`,
      `scrypt$1024$8$1$${salt}`,
      `scrypt$1024$8$1$${salt}$${key}$extra`,
      `scrypt$abc$8$1$${salt}$${key}`,
      `scrypt$1000$8$1$${salt}$${key}`, // N não é potência de 2
      `scrypt$512$8$1$${salt}$${key}`, // N abaixo do mínimo
      `scrypt$1073741824$8$1$${salt}$${key}`, // pediria gigabytes
      `scrypt$1024$1024$1$${salt}$${key}`,
      `scrypt$1024$8$99$${salt}$${key}`,
      `scrypt$1024$0$1$${salt}$${key}`,
      `scrypt$1024$8$1$@@@$${key}`,
      `scrypt$1024$8$1$${salt}$@@@`,
      `scrypt$1024$8$1$QQ==$${key}`, // sal curto demais
      `scrypt$1024$8$1$${salt}$QQ==`, // chave curta demais
      `scrypt$-1024$8$1$${salt}$${key}`,
      `scrypt$1.5$8$1$${salt}$${key}`,
      'x'.repeat(10_000),
    ];
    for (const value of malformed) {
      assert.equal(await hasher.verify(PASSWORD, value), false, value.slice(0, 40));
    }
  });

  it('dummyHash tem os mesmos parâmetros, é estável e nunca confere', async () => {
    const hasher = new ScryptPasswordHasher({ cost: LOW });
    const dummy = await hasher.dummyHash();
    assert.ok(dummy.startsWith('scrypt$1024$8$1$'));
    assert.equal(await hasher.dummyHash(), dummy);
    assert.equal(await hasher.verify(PASSWORD, dummy), false);
    assert.equal(await hasher.verify('', dummy), false);
  });

  it('custo fora da faixa aceita é recusado na construção', () => {
    for (const cost of [
      { N: 1000, r: 8, p: 1 },
      { N: 2 ** 30, r: 8, p: 1 },
      { N: 1024, r: 0, p: 1 },
      { N: 1024, r: 8, p: 0 },
    ]) {
      assert.throws(() => new ScryptPasswordHasher({ cost }), RangeError);
    }
  });

  it('o teto de hashes simultâneos é respeitado (nunca mais que 2 em execução)', async () => {
    assert.equal(MAX_CONCURRENT_HASHES, 2);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const derive: ScryptDerive = async (_password, _salt, keyLength) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return Buffer.alloc(keyLength, 7);
    };
    const hasher = new ScryptPasswordHasher({ cost: LOW, derive });
    const stored = await hasher.hash('x');
    await Promise.all([
      ...Array.from({ length: 10 }, () => hasher.hash('y')),
      ...Array.from({ length: 10 }, () => hasher.verify('x', stored)),
    ]);
    assert.equal(calls, 21);
    assert.equal(peak, 2, 'a fila usa as duas vagas e nunca passa delas');
    assert.equal(active, 0);
  });

  it('uma falha na derivação devolve a vaga (a fila não trava)', async () => {
    let fail = true;
    const derive: ScryptDerive = (_password, _salt, keyLength) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('falha de teste'));
      }
      return Promise.resolve(Buffer.alloc(keyLength, 1));
    };
    const hasher = new ScryptPasswordHasher({ cost: LOW, derive, maxConcurrent: 1 });
    await assert.rejects(hasher.hash('a'), /falha de teste/);
    assert.match(await hasher.hash('b'), /^scrypt\$/);
  });
});

describe('teto da fila de espera do hasher (spec 008)', () => {
  it('passou do teto, o pedido falha na hora com ServiceUnavailableError e a fila anda depois', async () => {
    assert.equal(MAX_QUEUED_HASHES, 32);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const derive: ScryptDerive = async (_password, _salt, keyLength) => {
      calls += 1;
      await gate;
      return Buffer.alloc(keyLength, 3);
    };
    const hasher = new ScryptPasswordHasher({ cost: LOW, derive, maxConcurrent: 1, maxQueued: 2 });
    // 1 em execução, 2 esperando: cabem.
    const accepted = [hasher.hash('a'), hasher.hash('b'), hasher.hash('c')];
    // O 4º passa do teto: recusado sem gastar derivação.
    await assert.rejects(hasher.hash('d'), ServiceUnavailableError);
    await assert.rejects(
      hasher.verify(
        'x',
        'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==',
      ),
      ServiceUnavailableError,
    );
    assert.equal(calls, 1, 'só o primeiro começou; o recusado não gastou hash');
    release?.();
    const results = await Promise.all(accepted);
    assert.equal(results.length, 3);
    assert.equal(calls, 3);
    // Esvaziada a fila, volta a aceitar.
    assert.match(await hasher.hash('e'), /^scrypt\$/);
  });

  it('maxQueued inválido é recusado; zero significa "sem fila"', async () => {
    assert.throws(() => new ScryptPasswordHasher({ cost: LOW, maxQueued: -1 }), RangeError);
    assert.throws(() => new ScryptPasswordHasher({ cost: LOW, maxQueued: 1.5 }), RangeError);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const derive: ScryptDerive = async (_p, _s, keyLength) => {
      await gate;
      return Buffer.alloc(keyLength, 1);
    };
    const hasher = new ScryptPasswordHasher({ cost: LOW, derive, maxConcurrent: 1, maxQueued: 0 });
    const first = hasher.hash('a');
    await assert.rejects(hasher.hash('b'), ServiceUnavailableError);
    release?.();
    await first;
  });
});

describe('política de senha (Zod)', () => {
  it('12 a 128 caracteres; menos ou mais recusa; sem regra de composição', () => {
    assert.equal(newPasswordSchema.safeParse('a'.repeat(11)).success, false);
    assert.equal(newPasswordSchema.safeParse('a'.repeat(12)).success, true);
    assert.equal(newPasswordSchema.safeParse('a'.repeat(128)).success, true);
    assert.equal(newPasswordSchema.safeParse('a'.repeat(129)).success, false);
    // Só minúsculas, sem dígito nem símbolo: vale (NIST SP 800-63B, sem regras de composição).
    assert.equal(newPasswordSchema.safeParse('apenasminusculas').success, true);
    assert.equal(newPasswordSchema.safeParse('            ').success, true);
  });

  it('o caractere NUL é recusado e o valor não é ecoado', () => {
    const result = newPasswordSchema.safeParse('senha-com-nul\u0000-forte');
    assert.equal(result.success, false);
    assert.ok(!JSON.stringify(result.error.issues).includes('senha-com-nul'));
  });

  it('normaliza em NFKC antes de contar e de fazer o hash', () => {
    // A ligadura U+FB01 vira "fi": duas formas de escrever a mesma senha viram uma só.
    const parsed = newPasswordSchema.safeParse('ﬁnal-de-semana-ok');
    assert.ok(parsed.success);
    assert.equal(parsed.data, 'final-de-semana-ok');
    // "é" composto e decomposto resultam no mesmo valor.
    assert.equal(
      newPasswordSchema.parse('café-com-leite-1'),
      newPasswordSchema.parse('café-com-leite-1'),
    );
    // A contagem é depois da normalização: 6 ligaduras viram 12 caracteres e valem.
    assert.equal(newPasswordSchema.safeParse('ﬁ'.repeat(6)).success, true);
  });
});

describe('fila separada dos hashes de administração (spec 008, revisão I-1)', () => {
  it('a fila cheia de administração recusa só a administração; o login segue com as vagas restantes', async () => {
    assert.equal(MAX_QUEUED_ADMIN_HASHES, 8);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const derive: ScryptDerive = async (_p, _s, keyLength) => {
      await gate;
      return Buffer.alloc(keyLength, 2);
    };
    const hasher = new ScryptPasswordHasher({
      cost: LOW,
      derive,
      maxConcurrent: 1,
      maxQueued: 5,
      maxQueuedAdmin: 2,
    });
    const accepted: Promise<unknown>[] = [hasher.hash('em-execucao')];
    accepted.push(hasher.hash('a1', { lane: 'admin' }), hasher.hash('a2', { lane: 'admin' }));
    // Teto de administração atingido: recusa imediata, só para ela.
    await assert.rejects(hasher.hash('a3', { lane: 'admin' }), ServiceUnavailableError);
    // Login (lane padrão) ainda cabe nas vagas restantes: 3 do total de 5.
    for (const name of ['l1', 'l2', 'l3']) accepted.push(hasher.hash(name));
    // Total cheio: aí sim o login também é recusado.
    await assert.rejects(hasher.hash('l4'), ServiceUnavailableError);
    release?.();
    await Promise.all(accepted);
    assert.match(await hasher.hash('depois', { lane: 'admin' }), /^scrypt\$/);
  });

  it('maxQueuedAdmin inválido é recusado', () => {
    assert.throws(() => new ScryptPasswordHasher({ cost: LOW, maxQueuedAdmin: -1 }), RangeError);
  });
});
