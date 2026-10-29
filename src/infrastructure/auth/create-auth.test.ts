import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { warmUpAuth } from './create-auth.js';
import { type ScryptDerive, ScryptPasswordHasher } from './scrypt-password-hasher.js';

const LOW = { N: 1024, r: 8, p: 1 } as const;

function counting(): { derive: ScryptDerive; calls: () => number } {
  let calls = 0;
  const derive: ScryptDerive = (_password, _salt, keyLength) => {
    calls += 1;
    return Promise.resolve(Buffer.alloc(keyLength, 3));
  };
  return { derive, calls: () => calls };
}

describe('warmUpAuth (hash fictício pré-aquecido)', () => {
  it('gera o hash fictício uma vez no boot; verificar conta inexistente depois não gera hash novo', async () => {
    const { derive, calls } = counting();
    const hasher = new ScryptPasswordHasher({ cost: LOW, derive });
    await warmUpAuth({ hasher });
    assert.equal(calls(), 1, 'o pré-aquecimento paga o hash uma vez');
    // Login de conta inexistente: dummyHash() (memoizado) + um verify. Nenhum hash novo.
    const dummy = await hasher.dummyHash();
    await hasher.verify('qualquer-senha-12345', dummy);
    assert.equal(calls(), 2, 'só o verify do login; sem um segundo hash');
    await hasher.dummyHash();
    assert.equal(calls(), 2);
  });

  it('falha no pré-aquecimento é ignorada e o hash é refeito na primeira necessidade', async () => {
    let fail = true;
    const derive: ScryptDerive = (_password, _salt, keyLength) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('falha de teste'));
      }
      return Promise.resolve(Buffer.alloc(keyLength, 3));
    };
    const hasher = new ScryptPasswordHasher({ cost: LOW, derive });
    await warmUpAuth({ hasher });
    assert.match(await hasher.dummyHash(), /^scrypt\$/);
  });
});
