import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '../domain/index.js';

/** Estado das colunas de verificação de uma conta, como o teste de contrato as enxerga. */
export interface VerificationState {
  readonly hash: string | null;
  readonly expiresAt: Date | null;
  readonly attempts: number;
  readonly failuresDay: number;
  readonly failuresSince: Date | null;
  readonly emailVerifiedAt: Date | null;
}

export interface AccountContractHarness {
  readonly repo: AccountRepository;
  state(email: string): Promise<VerificationState>;
}

const T0 = new Date('2026-11-03T12:00:00.000Z');
const TTL = 15 * 60_000;
const GAP = 60_000;
const DAY = 24 * 60 * 60_000;
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/**
 * Contrato do `AccountRepository` para a confirmação por código de 6 dígitos (spec 020): o mesmo
 * roteiro roda contra o repositório em memória (unitário) e contra o Postgres (integração).
 * Todos os instantes são parâmetros (`T0 + ms`), nunca o relógio da máquina nem do banco.
 */
export async function runAccountRepositoryContract(
  harness: AccountContractHarness,
  newEmail: () => string,
): Promise<void> {
  const { repo } = harness;
  const state = (email: string): Promise<VerificationState> => harness.state(email);

  const register = (email: string, hash: string, ms: number): Promise<string | null> =>
    repo.registerUnverified({
      id: randomUUID(),
      email,
      passwordHash: 'senha-hash',
      verificationHash: hash,
      expiresAt: at(ms + TTL),
      retryBefore: at(ms + TTL - GAP),
      now: at(ms),
    });
  const refresh = (id: string, hash: string, ms: number): Promise<boolean> =>
    repo.refreshVerification(id, hash, at(ms + TTL), at(ms + TTL - GAP), at(ms));
  const registered = async (email: string, hash: string, ms = 0): Promise<string> => {
    const id = await register(email, hash, ms);
    assert.ok(id);
    return id;
  };

  // 1. Quatro erros e o código certo confirmam; os contadores zeram.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-1');
    assert.equal((await state(email)).attempts, 0);
    for (let i = 1; i <= 4; i += 1) {
      assert.equal(await repo.verify(id, 'errado', at(1000 + i)), 'wrong');
      assert.equal((await state(email)).attempts, i);
    }
    assert.equal(await repo.verify(id, 'hash-1', at(2000)), 'verified');
    const done = await state(email);
    assert.equal(done.hash, null);
    assert.equal(done.expiresAt, null);
    assert.equal(done.attempts, 0);
    assert.equal(done.failuresDay, 0);
    assert.equal(done.failuresSince, null);
    assert.ok(done.emailVerifiedAt);
    // Já confirmada: nada confere nem conta.
    assert.equal(await repo.verify(id, 'hash-1', at(3000)), 'unavailable');
    assert.equal(await register(email, 'outro', 61_000), null);
    assert.equal(await refresh(id, 'outro', 61_000), false);
  }

  // 2. Cinco erros matam o código (o vencimento fica); o certo depois não confirma; o reenvio
  // respeita o intervalo de 60 s desde o envio e o código novo zera o contador do código.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-2');
    for (let i = 1; i <= 4; i += 1) {
      assert.equal(await repo.verify(id, 'errado', at(1000 + i)), 'wrong');
    }
    assert.equal(await repo.verify(id, 'errado', at(1100)), 'exhausted');
    const dead = await state(email);
    assert.equal(dead.hash, null);
    assert.equal(dead.expiresAt?.getTime(), at(TTL).getTime());
    assert.equal(dead.attempts, 5);
    assert.equal(dead.failuresDay, 5);
    assert.equal(await repo.verify(id, 'hash-2', at(1200)), 'unavailable');
    assert.equal(await repo.verify(id, 'errado', at(1300)), 'unavailable');
    assert.equal((await state(email)).attempts, 5);
    assert.equal((await state(email)).emailVerifiedAt, null);
    // Antes de 60 s do envio: nem cadastro repetido nem reenvio.
    assert.equal(await register(email, 'novo', 30_000), null);
    assert.equal(await refresh(id, 'novo', 30_000), false);
    assert.equal(await refresh(id, 'hash-2b', 61_000), true);
    const fresh = await state(email);
    assert.equal(fresh.hash, 'hash-2b');
    assert.equal(fresh.attempts, 0);
    // O teto diário não zera com o reenvio.
    assert.equal(fresh.failuresDay, 5);
    assert.equal(await repo.verify(id, 'hash-2', at(62_000)), 'wrong');
    assert.equal(await repo.verify(id, 'hash-2b', at(63_000)), 'verified');
    assert.equal((await state(email)).failuresDay, 0);
  }

  // 3. Código vencido não confere nem conta como erro.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-3');
    assert.equal(await repo.verify(id, 'errado', at(TTL - 1)), 'wrong');
    assert.equal(await repo.verify(id, 'hash-3', at(TTL)), 'unavailable');
    assert.equal(await repo.verify(id, 'errado', at(TTL + 1)), 'unavailable');
    const expired = await state(email);
    assert.equal(expired.attempts, 1);
    assert.equal(expired.emailVerifiedAt, null);
  }

  // 4. Novo cadastro (conta não confirmada) mata o código anterior e zera o contador.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-4');
    assert.equal(await repo.verify(id, 'errado', at(1000)), 'wrong');
    assert.equal(await repo.verify(id, 'errado', at(1001)), 'wrong');
    assert.equal(await register(email, 'hash-4b', 61_000), id);
    const again = await state(email);
    assert.equal(again.hash, 'hash-4b');
    assert.equal(again.attempts, 0);
    assert.equal(await repo.verify(id, 'hash-4', at(62_000)), 'wrong');
    assert.equal(await repo.verify(id, 'hash-4b', at(63_000)), 'verified');
  }

  // 5. Teto diário: 5 códigos esgotados (25 erros) bloqueiam código novo até a janela de 24 h,
  // aberta no primeiro erro, passar.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-5-0');
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const start = cycle * 61_000;
      if (cycle > 0) assert.equal(await refresh(id, `hash-5-${cycle}`, start), true);
      for (let i = 1; i <= 4; i += 1) {
        assert.equal(await repo.verify(id, 'errado', at(start + 1000 + i)), 'wrong');
      }
      assert.equal(await repo.verify(id, 'errado', at(start + 1100)), 'exhausted');
    }
    const capped = await state(email);
    assert.equal(capped.failuresDay, 25);
    assert.equal(capped.hash, null);
    assert.equal(capped.failuresSince?.getTime(), at(1001).getTime());
    const later = 5 * 61_000;
    assert.equal(await refresh(id, 'bloqueado', later), false);
    assert.equal(await register(email, 'bloqueado', later), null);
    assert.equal(await refresh(id, 'bloqueado', 1001 + DAY - 1), false);
    assert.equal((await state(email)).hash, null);
    // Passada a janela, o código novo sai e o primeiro erro abre uma janela nova.
    assert.equal(await refresh(id, 'liberado', 1001 + DAY), true);
    assert.equal(await repo.verify(id, 'errado', at(1001 + DAY + 1000)), 'wrong');
    const reopened = await state(email);
    assert.equal(reopened.failuresDay, 1);
    assert.equal(reopened.failuresSince?.getTime(), at(1001 + DAY + 1000).getTime());
    assert.equal(await repo.verify(id, 'liberado', at(1001 + DAY + 2000)), 'verified');
  }

  // 6. O teto diário também mata o código vigente mesmo com poucos erros nele (reenvios zeram o
  // contador do código, não o do dia): 24 erros em 6 códigos, o 25º mata o sétimo no 1º erro.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-6-0');
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const start = cycle * 61_000;
      if (cycle > 0) assert.equal(await refresh(id, `hash-6-${cycle}`, start), true);
      for (let i = 1; i <= 4; i += 1) {
        assert.equal(await repo.verify(id, 'errado', at(start + 1000 + i)), 'wrong');
      }
    }
    const start = 6 * 61_000;
    assert.equal(await refresh(id, 'hash-6-6', start), true);
    assert.equal(await repo.verify(id, 'errado', at(start + 1000)), 'exhausted');
    const killed = await state(email);
    assert.equal(killed.attempts, 1);
    assert.equal(killed.failuresDay, 25);
    assert.equal(killed.hash, null);
    assert.equal(await repo.verify(id, 'hash-6-6', at(start + 2000)), 'unavailable');
    assert.equal((await state(email)).emailVerifiedAt, null);
  }

  // 7. Falha de envio (`clearVerification`) apaga o código e zera o contador, liberando o reenvio.
  {
    const email = newEmail();
    const id = await registered(email, 'hash-7');
    assert.equal(await repo.verify(id, 'errado', at(1000)), 'wrong');
    await repo.clearVerification(id, 'hash-7');
    const cleared = await state(email);
    assert.equal(cleared.hash, null);
    assert.equal(cleared.expiresAt, null);
    assert.equal(cleared.attempts, 0);
    assert.equal(await refresh(id, 'hash-7b', 2000), true);
  }
}

// O contrato da recuperação de senha (spec 021) mora em arquivo próprio e é exportado daqui, para os
// dois repositórios importarem tudo do mesmo lugar.
export {
  runPasswordResetContract,
  type ResetContractHarness,
  type ResetState,
} from './account-reset-contract.js';
