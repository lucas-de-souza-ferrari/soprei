import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { VerifyOutcome } from '../../domain/index.js';
import { RateLimitError, UnauthorizedError } from '../../shared/errors/index.js';
import { InMemoryAccountRepository } from '../../test-support/in-memory-account.repository.js';
import { FakePasswordHasher, InMemorySessionStore } from '../../test-support/in-memory-auth.js';
import type { AccountSessionStore, VerificationMailer } from '../ports/account-session.js';
import { AccountService } from './account.service.js';
import { deriveVerificationKey, verificationDigest, type RandomInt } from './verification-code.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0123456789';
const PASSWORD = 'Senha1-valida';
const A = 'conta-a@example.test';
const B = 'conta-b@example.test';
const WRONG = '000001';
const MINUTE = 60_000;

const sessions: AccountSessionStore = {
  create: () => Promise.resolve('sessao'),
  read: () => Promise.resolve(null),
  select: () => Promise.resolve(),
  revoke: () => Promise.resolve(),
};

function harness(
  options: { secret?: string; randomInt?: RandomInt; observerThrows?: boolean } = {},
) {
  const time = { now: new Date('2026-11-03T12:00:00.000Z').getTime(), mailFails: false };
  const accounts = new InMemoryAccountRepository();
  const store = new InMemorySessionStore({ now: () => new Date(time.now) });
  const mails: { email: string; code: string }[] = [];
  const outcomes: VerifyOutcome[] = [];
  const mailer: VerificationMailer = {
    sendVerification: (email, code) => {
      if (time.mailFails) return Promise.reject(new Error('SMTP segredo que não pode vazar'));
      mails.push({ email, code });
      return Promise.resolve();
    },
  };
  let counter = 100_000;
  const service = new AccountService({
    accounts,
    passwords: new FakePasswordHasher(),
    sessions,
    mailer,
    loginLocks: store,
    loginSecret: options.secret ?? SECRET,
    now: () => new Date(time.now),
    randomInt: options.randomInt ?? (() => counter++),
    onVerificationAttempt: (result) => {
      outcomes.push(result);
      if (options.observerThrows) throw new Error('observador quebrado');
    },
  });
  const lastCode = (): string => {
    const mail = mails.at(-1);
    assert.ok(mail);
    return mail.code;
  };
  return {
    service,
    accounts,
    mails,
    outcomes,
    time,
    lastCode,
    advance(ms: number) {
      time.now += ms;
    },
    /** Cadastra e devolve o código enviado (o envio é em segundo plano). */
    async signup(email: string, password = PASSWORD): Promise<string> {
      await service.register(email, password);
      await service.drain();
      return lastCode();
    },
  };
}

interface Failure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}
async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { status: error.statusCode, code: error.code, message: error.message };
    }
    throw error;
  }
  return assert.fail('deveria ter sido recusado');
}
const UNIFORM: Failure = {
  status: 401,
  code: 'UNAUTHORIZED',
  message: 'Confirmação inválida ou expirada',
};

test('cadastro e reenvio guardam o HMAC do código, nunca o código nem SHA-256 simples', async () => {
  const h = harness({ randomInt: () => 42 });
  assert.equal(await h.signup(A), '000042');
  assert.equal(await h.signup(B), '000042');
  const hashA = h.accounts.peek(A).verificationHash;
  const hashB = h.accounts.peek(B).verificationHash;
  assert.ok(hashA && hashB);
  assert.equal(hashA, verificationDigest(deriveVerificationKey(SECRET), A, '000042'));
  // O mesmo código em duas contas gera hashes diferentes.
  assert.notEqual(hashA, hashB);
  assert.notEqual(hashA, createHash('sha256').update('000042').digest('hex'));
  assert.ok(!hashA.includes('000042'));
  // Chave diferente, hash diferente (o segredo entra na derivação).
  const other = harness({
    randomInt: () => 42,
    secret: 'outro-segredo-com-mais-de-32-caracteres-9876',
  });
  await other.signup(A);
  assert.notEqual(other.accounts.peek(A).verificationHash, hashA);
  // Reenvio: código novo, HMAC do código novo.
  const resend = harness();
  const first = await resend.signup(A);
  resend.advance(61_000);
  await resend.service.resend(A, PASSWORD);
  const second = resend.lastCode();
  assert.notEqual(second, first);
  assert.match(second, /^\d{6}$/);
  assert.equal(
    resend.accounts.peek(A).verificationHash,
    verificationDigest(deriveVerificationKey(SECRET), A, second),
  );
});

test('código certo confirma; errado, vencido, já usado e de conta confirmada dão a mesma 401', async () => {
  const h = harness();
  const code = await h.signup(A);
  const failures = [await failure(h.service.verify(A, PASSWORD, WRONG))];
  await h.service.verify(A, PASSWORD, code);
  assert.ok(h.accounts.peek(A).emailVerifiedAt);
  // Já usado / conta já confirmada.
  failures.push(await failure(h.service.verify(A, PASSWORD, code)));
  failures.push(await failure(h.service.verify(A, PASSWORD, WRONG)));
  // Vencido: relógio avançado 15 minutos.
  const expiring = await h.signup(B);
  h.advance(15 * MINUTE);
  failures.push(await failure(h.service.verify(B, PASSWORD, expiring)));
  for (const item of failures) assert.deepEqual(item, UNIFORM);
  assert.deepEqual(h.outcomes, ['wrong', 'verified', 'unavailable', 'unavailable', 'unavailable']);
});

test('4 erros e o 5º certo confirmam', async () => {
  const h = harness();
  const code = await h.signup(A);
  for (let i = 0; i < 4; i += 1)
    assert.deepEqual(await failure(h.service.verify(A, PASSWORD, WRONG)), UNIFORM);
  assert.equal(h.accounts.peek(A).verificationAttempts, 4);
  await h.service.verify(A, PASSWORD, code);
  assert.ok(h.accounts.peek(A).emailVerifiedAt);
  assert.deepEqual(h.outcomes, ['wrong', 'wrong', 'wrong', 'wrong', 'verified']);
});

test('5 erros matam o código: o 6º envio, mesmo certo, responde a mesma 401 e a conta segue sem confirmar', async () => {
  const h = harness();
  const code = await h.signup(A);
  for (let i = 0; i < 5; i += 1)
    assert.deepEqual(await failure(h.service.verify(A, PASSWORD, WRONG)), UNIFORM);
  assert.deepEqual(await failure(h.service.verify(A, PASSWORD, code)), UNIFORM);
  const row = h.accounts.peek(A);
  assert.equal(row.emailVerifiedAt, null);
  assert.equal(row.verificationHash, null);
  assert.deepEqual(h.outcomes, ['wrong', 'wrong', 'wrong', 'wrong', 'exhausted', 'unavailable']);
});

test('depois de esgotar, o reenvio espera os 60 s do envio e o código novo zera o contador e confirma', async () => {
  const h = harness();
  const first = await h.signup(A);
  for (let i = 0; i < 5; i += 1) await failure(h.service.verify(A, PASSWORD, WRONG));
  h.advance(30_000);
  await h.service.resend(A, PASSWORD);
  assert.equal(h.mails.length, 1, 'antes de 60 s desde o envio nada é enviado');
  h.advance(31_000);
  await h.service.resend(A, PASSWORD);
  assert.equal(h.mails.length, 2);
  const fresh = h.lastCode();
  assert.notEqual(fresh, first);
  assert.equal(h.accounts.peek(A).verificationAttempts, 0);
  assert.deepEqual(await failure(h.service.verify(A, PASSWORD, first)), UNIFORM);
  await h.service.verify(A, PASSWORD, fresh);
  assert.ok(h.accounts.peek(A).emailVerifiedAt);
});

test('novo cadastro e reenvio invalidam o código anterior e zeram o contador de erros', async () => {
  const h = harness();
  const first = await h.signup(A);
  await failure(h.service.verify(A, PASSWORD, WRONG));
  await failure(h.service.verify(A, PASSWORD, WRONG));
  assert.equal(h.accounts.peek(A).verificationAttempts, 2);
  h.advance(61_000);
  const second = await h.signup(A, 'Outra1-senha');
  assert.notEqual(second, first);
  assert.equal(h.accounts.peek(A).verificationAttempts, 0);
  // O código antigo deixou de conferir (a senha agora é a do segundo cadastro).
  assert.deepEqual(await failure(h.service.verify(A, 'Outra1-senha', first)), UNIFORM);
  assert.equal(h.accounts.peek(A).verificationAttempts, 1);
  h.advance(61_000);
  await h.service.resend(A, 'Outra1-senha');
  const third = h.lastCode();
  assert.equal(h.accounts.peek(A).verificationAttempts, 0);
  assert.deepEqual(await failure(h.service.verify(A, 'Outra1-senha', second)), UNIFORM);
  await h.service.verify(A, 'Outra1-senha', third);
  assert.ok(h.accounts.peek(A).emailVerifiedAt);
});

test('senha errada não conta como erro do código, segue no bloqueio por conta e a conta bloqueada responde 429', async () => {
  const h = harness();
  const code = await h.signup(A);
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(h.service.verify(A, 'senha-errada', code), (error) => {
      assert.ok(error instanceof UnauthorizedError);
      assert.equal(error.message, 'Credenciais inválidas');
      return true;
    });
  }
  assert.equal(h.accounts.peek(A).verificationAttempts, 0);
  assert.equal(h.accounts.peek(A).verificationFailuresDay, 0);
  // Bloqueada: nem a senha certa com o código certo chega à comparação.
  await assert.rejects(h.service.verify(A, PASSWORD, code), RateLimitError);
  assert.equal(h.accounts.peek(A).emailVerifiedAt, null);
  assert.equal(h.accounts.peek(A).verificationAttempts, 0);
  assert.deepEqual(h.outcomes, []);
});

test('teto diário: 25 erros em 5 códigos bloqueiam código novo até a janela de 24 h passar', async () => {
  const h = harness();
  await h.signup(A);
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let i = 0; i < 5; i += 1) await failure(h.service.verify(A, PASSWORD, WRONG));
    h.advance(61_000);
    const before = h.mails.length;
    await h.service.resend(A, PASSWORD);
    // Os quatro primeiros reenvios saem; o quinto (depois do 25º erro) não.
    assert.equal(h.mails.length, cycle < 4 ? before + 1 : before);
  }
  // Cadastro repetido também não emite código novo, e a resposta é a mesma (sem erro).
  const sent = h.mails.length;
  await h.service.register(A, PASSWORD);
  await h.service.drain();
  assert.equal(h.mails.length, sent);
  assert.equal(h.accounts.peek(A).verificationHash, null);
  // Passada a janela, o código sai e confirma.
  h.advance(24 * 60 * MINUTE);
  await h.service.resend(A, PASSWORD);
  assert.equal(h.mails.length, sent + 1);
  await h.service.verify(A, PASSWORD, h.lastCode());
  const row = h.accounts.peek(A);
  assert.ok(row.emailVerifiedAt);
  assert.equal(row.verificationFailuresDay, 0);
  assert.equal(row.verificationFailuresSince, null);
});

test('observador que falha não derruba a confirmação e recebe só id e resultado', async () => {
  const h = harness({ observerThrows: true });
  const code = await h.signup(A);
  assert.deepEqual(await failure(h.service.verify(A, PASSWORD, WRONG)), UNIFORM);
  await h.service.verify(A, PASSWORD, code);
  assert.deepEqual(h.outcomes, ['wrong', 'verified']);
});

test('falha de envio apaga o código e o contador e libera novo envio na hora', async () => {
  const h = harness();
  h.time.mailFails = true;
  await h.service.register(A, PASSWORD);
  await h.service.drain();
  assert.equal(h.mails.length, 0);
  const row = h.accounts.peek(A);
  assert.equal(row.verificationHash, null);
  assert.equal(row.verificationAttempts, 0);
  h.time.mailFails = false;
  await h.service.register(A, PASSWORD);
  await h.service.drain();
  assert.equal(h.mails.length, 1);
});
