import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '../domain/index.js';

/** Estado das colunas de recuperação de senha de uma conta, como o contrato as enxerga. */
export interface ResetState {
  readonly hash: string | null;
  readonly expiresAt: Date | null;
  readonly attempts: number;
  readonly failuresDay: number;
  readonly failuresSince: Date | null;
  readonly passwordHash: string;
}

export interface ResetContractHarness {
  readonly repo: AccountRepository;
  resetState(email: string): Promise<ResetState>;
}

const T0 = new Date('2026-11-03T12:00:00.000Z');
const TTL = 15 * 60_000;
const GAP = 60_000;
const DAY = 24 * 60 * 60_000;
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/**
 * Contrato do `AccountRepository` para a recuperação de senha (spec 021): o mesmo roteiro roda
 * contra o repositório em memória (unitário) e contra o Postgres (integração). Todos os instantes
 * são parâmetros (`T0 + ms`), nunca o relógio da máquina nem do banco.
 */
export async function runPasswordResetContract(
  harness: ResetContractHarness,
  newEmail: () => string,
): Promise<void> {
  const { repo } = harness;
  const state = (email: string): Promise<ResetState> => harness.resetState(email);
  const confirmed = async (email: string): Promise<string> => {
    const id = await repo.registerUnverified({
      id: randomUUID(),
      email,
      passwordHash: 'senha-antiga',
      verificationHash: `v-${email}`,
      expiresAt: at(TTL),
      retryBefore: at(TTL - GAP),
      now: at(0),
    });
    assert.ok(id);
    assert.equal(await repo.verify(id, `v-${email}`, at(1)), 'verified');
    return id;
  };
  const issue = (email: string, hash: string, ms: number): Promise<string | null> =>
    repo.issueResetCode(email, hash, at(ms + TTL), at(ms + TTL - GAP), at(ms));

  // 1. Só conta confirmada recebe código; o intervalo de 60 s vale e o código novo substitui o antigo.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'r1', 1000), id);
    const first = await state(email);
    assert.equal(first.hash, 'r1');
    assert.equal(first.attempts, 0);
    assert.equal(first.expiresAt?.getTime(), at(1000 + TTL).getTime());
    assert.equal(await issue(email, 'r1-cedo', 1000 + 30_000), null);
    assert.equal((await state(email)).hash, 'r1');
    assert.equal(await repo.recordResetFailure(email, at(2000)), 'wrong');
    assert.equal(await issue(email, 'r2', 1000 + 61_000), id);
    const second = await state(email);
    assert.equal(second.hash, 'r2');
    assert.equal(second.attempts, 0);
    // O código antigo morreu; o contador do dia não zera com o pedido.
    assert.equal(await repo.hasValidResetCode(email, 'r1', at(70_000)), false);
    assert.equal(await repo.hasValidResetCode(email, 'r2', at(70_000)), true);
    assert.equal(second.failuresDay, 1);
  }

  // 2. Conta inexistente ou não confirmada: nada é gravado (a resposta é a mesma: null).
  {
    assert.equal(await issue(newEmail(), 'r', 0), null);
    const email = newEmail();
    await repo.registerUnverified({
      id: randomUUID(),
      email,
      passwordHash: 'h',
      verificationHash: 'v',
      expiresAt: at(TTL),
      retryBefore: at(TTL - GAP),
      now: at(0),
    });
    assert.equal(await issue(email, 'r', 61_000), null);
    assert.equal((await state(email)).hash, null);
    assert.equal(await repo.resetPassword(email, 'r', 'nova', at(62_000)), false);
    assert.equal(await repo.recordResetFailure(email, at(62_000)), 'unavailable');
    assert.equal((await state(email)).failuresDay, 0);
  }

  // 3. Código certo troca a senha, zera tudo e não vale de novo.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'r3', 1000), id);
    assert.equal(await repo.recordResetFailure(email, at(1100)), 'wrong');
    assert.equal(await repo.resetPassword(email, 'errado', 'nova-senha', at(1200)), false);
    assert.equal((await state(email)).passwordHash, 'senha-antiga');
    assert.equal(await repo.resetPassword(email, 'r3', 'nova-senha', at(1300)), true);
    const done = await state(email);
    assert.equal(done.passwordHash, 'nova-senha');
    assert.equal(done.hash, null);
    assert.equal(done.expiresAt, null);
    assert.equal(done.attempts, 0);
    assert.equal(done.failuresDay, 0);
    assert.equal(done.failuresSince, null);
    assert.equal(await repo.resetPassword(email, 'r3', 'outra', at(1400)), false);
    assert.equal((await state(email)).passwordHash, 'nova-senha');
  }

  // 4. Cinco erros matam o código (o vencimento fica); o certo depois não troca a senha; o pedido
  // respeita os 60 s e o código novo zera o contador do código, não o do dia.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'r4', 1000), id);
    for (let i = 1; i <= 4; i += 1) {
      assert.equal(await repo.recordResetFailure(email, at(1000 + i)), 'wrong');
    }
    assert.equal(await repo.recordResetFailure(email, at(1100)), 'exhausted');
    const dead = await state(email);
    assert.equal(dead.hash, null);
    assert.equal(dead.attempts, 5);
    assert.equal(dead.failuresDay, 5);
    assert.equal(dead.expiresAt?.getTime(), at(1000 + TTL).getTime());
    assert.equal(await repo.hasValidResetCode(email, 'r4', at(1200)), false);
    assert.equal(await repo.resetPassword(email, 'r4', 'nova', at(1200)), false);
    assert.equal(await repo.recordResetFailure(email, at(1300)), 'unavailable');
    assert.equal((await state(email)).attempts, 5);
    assert.equal(await issue(email, 'r4b', 1000 + 30_000), null);
    assert.equal(await issue(email, 'r4b', 1000 + 61_000), id);
    const fresh = await state(email);
    assert.equal(fresh.attempts, 0);
    assert.equal(fresh.failuresDay, 5);
    assert.equal(await repo.resetPassword(email, 'r4b', 'nova', at(70_000)), true);
    assert.equal((await state(email)).failuresDay, 0);
  }

  // 5. Código vencido não confere, não conta como erro e não troca a senha.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'r5', 0), id);
    assert.equal(await repo.hasValidResetCode(email, 'r5', at(TTL - 1)), true);
    assert.equal(await repo.hasValidResetCode(email, 'r5', at(TTL)), false);
    assert.equal(await repo.recordResetFailure(email, at(TTL)), 'unavailable');
    assert.equal(await repo.resetPassword(email, 'r5', 'nova', at(TTL)), false);
    assert.equal((await state(email)).attempts, 0);
    assert.equal((await state(email)).passwordHash, 'senha-antiga');
  }

  // 6. Teto diário de 10 erros por conta: mata o código vigente mesmo com poucos erros nele e
  // bloqueia código novo até a janela de 24 h (aberta no primeiro erro) passar.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'r6-0', 0), id);
    for (let i = 1; i <= 4; i += 1) {
      assert.equal(await repo.recordResetFailure(email, at(1000 + i)), 'wrong');
    }
    assert.equal(await issue(email, 'r6-1', 61_000), id);
    for (let i = 1; i <= 4; i += 1) {
      assert.equal(await repo.recordResetFailure(email, at(61_000 + 1000 + i)), 'wrong');
    }
    assert.equal(await issue(email, 'r6-2', 122_000), id);
    assert.equal(await repo.recordResetFailure(email, at(122_000 + 1000)), 'wrong');
    assert.equal(await repo.recordResetFailure(email, at(122_000 + 1001)), 'exhausted');
    const capped = await state(email);
    assert.equal(capped.failuresDay, 10);
    assert.equal(capped.attempts, 2);
    assert.equal(capped.hash, null);
    assert.equal(capped.failuresSince?.getTime(), at(1001).getTime());
    assert.equal(await repo.resetPassword(email, 'r6-2', 'nova', at(123_000)), false);
    assert.equal(await issue(email, 'bloqueado', 200_000), null);
    assert.equal(await issue(email, 'bloqueado', 1001 + DAY - 1), null);
    // Passada a janela, o pedido volta e o primeiro erro abre uma janela nova.
    assert.equal(await issue(email, 'liberado', 1001 + DAY), id);
    assert.equal(await repo.recordResetFailure(email, at(1001 + DAY + 1000)), 'wrong');
    const reopened = await state(email);
    assert.equal(reopened.failuresDay, 1);
    assert.equal(reopened.failuresSince?.getTime(), at(1001 + DAY + 1000).getTime());
    assert.equal(await repo.resetPassword(email, 'liberado', 'nova', at(1001 + DAY + 2000)), true);
    assert.equal((await state(email)).failuresDay, 0);
  }

  // 7. Falha de envio (`clearResetCode`) apaga o código e libera novo pedido na hora.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'r7', 1000), id);
    await repo.clearResetCode(id, 'outro-hash');
    assert.equal((await state(email)).hash, 'r7');
    await repo.clearResetCode(id, 'r7');
    const cleared = await state(email);
    assert.equal(cleared.hash, null);
    assert.equal(cleared.expiresAt, null);
    assert.equal(cleared.attempts, 0);
    assert.equal(await issue(email, 'r7b', 2000), id);
  }

  // 8. O código de recuperação e o de confirmação de e-mail vivem em colunas diferentes.
  {
    const email = newEmail();
    const id = await confirmed(email);
    assert.equal(await issue(email, 'mesmo-valor', 1000), id);
    assert.equal(await repo.verify(id, 'mesmo-valor', at(1100)), 'unavailable');
    assert.equal((await state(email)).hash, 'mesmo-valor');
  }
}
