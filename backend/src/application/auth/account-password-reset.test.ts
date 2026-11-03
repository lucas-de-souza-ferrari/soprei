import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { InMemoryAccountRepository } from '../../test-support/in-memory-account.repository.js';
import { FakePasswordHasher, InMemorySessionStore } from '../../test-support/in-memory-auth.js';
import type { AccountMailer, AccountSessionStore } from '../ports/account-session.js';
import { AccountService, type PasswordResetResult } from './account.service.js';
import { deriveResetKey, resetDigest } from './reset-code.js';
import { deriveVerificationKey, verificationDigest } from './verification-code.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0123456789';
const PASSWORD = 'Senha1-valida';
const NEW_PASSWORD = 'Nova1-senha';
const A = 'conta-a@example.test';
const B = 'conta-b@example.test';
const WRONG = '000001';
const MINUTE = 60_000;

interface Failure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}
const UNIFORM: Failure = {
  status: 401,
  code: 'UNAUTHORIZED',
  message: 'Código inválido ou expirado',
};

function harness(options: { observerThrows?: boolean; mailDelayMs?: number } = {}) {
  const time = { now: new Date('2026-11-03T12:00:00.000Z').getTime() };
  const accounts = new InMemoryAccountRepository();
  const store = new InMemorySessionStore({ now: () => new Date(time.now) });
  const hasher = new FakePasswordHasher();
  const codeMails: { email: string; code: string }[] = [];
  const notices: string[] = [];
  const verificationMails: { email: string; code: string }[] = [];
  const flags = { codeMailFails: false, noticeFails: false, hashFails: false };
  const revoked: string[] = [];
  const revokeFailures = new Set<number>();
  let revokeCalls = 0;
  const sessions: AccountSessionStore = {
    create: () => Promise.resolve('sessao'),
    read: () => Promise.resolve(null),
    select: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    revokeAll: (accountId) => {
      revokeCalls += 1;
      if (revokeFailures.has(revokeCalls))
        return Promise.reject(new ServiceUnavailableError('Sessão indisponível'));
      revoked.push(accountId);
      return Promise.resolve();
    },
  };
  const mailer: AccountMailer = {
    sendVerification: (email, code) => {
      verificationMails.push({ email, code });
      return Promise.resolve();
    },
    sendPasswordReset: async (email, code) => {
      if (options.mailDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.mailDelayMs));
      }
      if (flags.codeMailFails) throw new Error('SMTP segredo que não pode vazar');
      codeMails.push({ email, code });
    },
    sendPasswordChanged: (email) => {
      if (flags.noticeFails) return Promise.reject(new Error('SMTP segredo que não pode vazar'));
      notices.push(email);
      return Promise.resolve();
    },
  };
  const requests: ('issued' | 'ignored')[] = [];
  const attempts: [PasswordResetResult, string | undefined][] = [];
  const mailResults: string[] = [];
  const warnings: string[] = [];
  let counter = 100_000;
  const service = new AccountService({
    accounts,
    passwords: hasher,
    sessions,
    mailer,
    loginLocks: store,
    loginSecret: SECRET,
    now: () => new Date(time.now),
    randomInt: () => counter++,
    onPasswordResetRequest: (result) => {
      requests.push(result);
      if (options.observerThrows) throw new Error('observador quebrado');
    },
    onPasswordReset: (result, accountId) => {
      attempts.push([result, accountId]);
      if (options.observerThrows) throw new Error('observador quebrado');
    },
    onPasswordResetMail: (kind, result) => {
      mailResults.push(`${kind}:${result}`);
    },
    onWarning: (event) => warnings.push(event),
  });
  // `hash` falha sob comando (fila do hasher cheia).
  const realHash = hasher.hash.bind(hasher);
  hasher.hash = (password, hashOptions) =>
    flags.hashFails
      ? Promise.reject(new ServiceUnavailableError('Indisponível'))
      : realHash(password, hashOptions);
  return {
    service,
    accounts,
    hasher,
    codeMails,
    notices,
    verificationMails,
    flags,
    revoked,
    revokeFailures,
    requests,
    attempts,
    mailResults,
    warnings,
    time,
    advance(ms: number) {
      time.now += ms;
    },
    revokeCalls: () => revokeCalls,
    /** Conta cadastrada e confirmada por e-mail. */
    async confirmed(email: string): Promise<void> {
      await service.register(email, PASSWORD);
      await service.drain();
      const mail = verificationMails.at(-1);
      assert.ok(mail);
      await service.verify(email, PASSWORD, mail.code);
    },
    /** Pede o código e devolve o enviado (o envio é em segundo plano). */
    async request(email: string): Promise<string> {
      const before = codeMails.length;
      await service.requestPasswordReset(email);
      await service.drain();
      assert.equal(codeMails.length, before + 1, 'o pedido deveria ter enviado um código');
      const mail = codeMails.at(-1);
      assert.ok(mail);
      return mail.code;
    },
  };
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

test('pedido: o mesmo resultado para inexistente, não confirmada, desativada, confirmada, cedo demais e teto diário; só a apta envia', async () => {
  const h = harness();
  // Inexistente.
  await h.service.requestPasswordReset('ninguem@example.test');
  // Não confirmada.
  await h.service.register(B, PASSWORD);
  await h.service.drain();
  await h.service.requestPasswordReset(B);
  // Desativada (confirmada, depois desativada).
  const disabled = 'desativada@example.test';
  await h.confirmed(disabled);
  h.accounts.patch(disabled, { status: 'DISABLED' });
  await h.service.requestPasswordReset(disabled);
  await h.service.drain();
  assert.equal(h.codeMails.length, 0);
  assert.deepEqual(h.requests, ['ignored', 'ignored', 'ignored']);
  // Confirmada e ativa: grava e envia.
  await h.confirmed(A);
  const code = await h.request(A);
  assert.match(code, /^\d{6}$/);
  assert.equal(h.codeMails.at(-1)?.email, A);
  // Cedo demais (menos de 60 s): mesma resposta, nenhum e-mail novo, o código antigo segue valendo.
  h.advance(30_000);
  await h.service.requestPasswordReset(A);
  await h.service.drain();
  assert.equal(h.codeMails.length, 1);
  assert.equal(h.requests.at(-1), 'ignored');
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
  // Teto diário: 10 erros no dia bloqueiam o pedido (mesma resposta, sem e-mail).
  const capped = 'teto@example.test';
  await h.confirmed(capped);
  h.accounts.patch(capped, { resetFailuresDay: 10, resetFailuresSince: new Date(h.time.now) });
  const before = h.codeMails.length;
  await h.service.requestPasswordReset(capped);
  await h.service.drain();
  assert.equal(h.codeMails.length, before);
  assert.equal(h.requests.at(-1), 'ignored');
});

test('o código é guardado como HMAC com o rótulo da recuperação; chave diferente muda o hash; o código não aparece no banco', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  const stored = h.accounts.peek(A).resetHash;
  assert.ok(stored);
  assert.equal(stored, resetDigest(deriveResetKey(SECRET), A, code));
  assert.ok(!stored.includes(code));
  assert.notEqual(
    stored,
    resetDigest(deriveResetKey('outro-segredo-com-mais-de-32-caracteres-9876'), A, code),
  );
  // O rótulo é outro: o mesmo e-mail e código não geram o hash da confirmação de e-mail.
  assert.notEqual(stored, verificationDigest(deriveVerificationKey(SECRET), A, code));
  assert.notEqual(
    deriveResetKey(SECRET).toString('hex'),
    deriveVerificationKey(SECRET).toString('hex'),
  );
});

test('separação de finalidade: código de confirmação não redefine senha e código de recuperação não confirma e-mail', async () => {
  const h = harness();
  await h.service.register(A, PASSWORD);
  await h.service.drain();
  const verificationCode = h.verificationMails.at(-1)?.code ?? '';
  const hashBefore = h.accounts.peek(A).passwordHash;
  // Conta não confirmada: o código de confirmação não redefine a senha.
  assert.deepEqual(
    await failure(h.service.confirmPasswordReset(A, verificationCode, NEW_PASSWORD)),
    UNIFORM,
  );
  assert.equal(h.accounts.peek(A).passwordHash, hashBefore);
  // Código de recuperação forjado no banco de conta não confirmada: não confirma o e-mail.
  const forged = '424242';
  h.accounts.patch(A, {
    resetHash: resetDigest(deriveResetKey(SECRET), A, forged),
    resetExpiresAt: new Date(h.time.now + 15 * MINUTE),
  });
  await assert.rejects(h.service.verify(A, PASSWORD, forged), UnauthorizedError);
  assert.equal(h.accounts.peek(A).emailVerifiedAt, null);
  // E o forjado também não redefine a senha de conta não confirmada.
  assert.deepEqual(await failure(h.service.confirmPasswordReset(A, forged, NEW_PASSWORD)), UNIFORM);
  await assert.rejects(h.service.login(A, NEW_PASSWORD), UnauthorizedError);
  // Conta confirmada: o código da confirmação de e-mail (já usado) não vale como de recuperação.
  const confirmedEmail = 'confirmada@example.test';
  await h.confirmed(confirmedEmail);
  const used = h.verificationMails.at(-1)?.code ?? '';
  assert.deepEqual(
    await failure(h.service.confirmPasswordReset(confirmedEmail, used, NEW_PASSWORD)),
    UNIFORM,
  );
});

test('código certo troca a senha, não loga ninguém e o código usado não vale de novo', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
  await assert.rejects(h.service.login(A, PASSWORD), UnauthorizedError);
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');
  assert.deepEqual(await failure(h.service.confirmPasswordReset(A, code, 'Outra1-senha')), UNIFORM);
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');
  assert.deepEqual(
    h.attempts.map(([result]) => result),
    ['reset', 'unavailable'],
  );
});

test('errado, vencido, esgotado, já usado, inexistente, não confirmada e desativada: a mesma 401', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  const failures = [await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD))];
  // Vencido.
  h.advance(15 * MINUTE);
  failures.push(await failure(h.service.confirmPasswordReset(A, code, NEW_PASSWORD)));
  // Esgotado.
  const second = await h.request(A);
  for (let i = 0; i < 5; i += 1)
    await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD));
  failures.push(await failure(h.service.confirmPasswordReset(A, second, NEW_PASSWORD)));
  // Já usado.
  h.advance(MINUTE + 1);
  const third = await h.request(A);
  await h.service.confirmPasswordReset(A, third, NEW_PASSWORD);
  failures.push(await failure(h.service.confirmPasswordReset(A, third, NEW_PASSWORD)));
  // Conta inexistente, não confirmada e desativada.
  failures.push(
    await failure(h.service.confirmPasswordReset('ninguem@example.test', code, NEW_PASSWORD)),
  );
  await h.service.register(B, PASSWORD);
  failures.push(await failure(h.service.confirmPasswordReset(B, code, NEW_PASSWORD)));
  const disabled = 'desativada@example.test';
  await h.confirmed(disabled);
  const disabledCode = await h.request(disabled);
  h.accounts.patch(disabled, { status: 'DISABLED' });
  failures.push(
    await failure(h.service.confirmPasswordReset(disabled, disabledCode, NEW_PASSWORD)),
  );
  for (const item of failures) assert.deepEqual(item, UNIFORM);
});

test('4 erros e o 5º certo redefinem; 5 erros matam o código e o certo depois é 401; o pedido espera os 60 s', async () => {
  const h = harness();
  await h.confirmed(A);
  const first = await h.request(A);
  for (let i = 0; i < 4; i += 1)
    await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD));
  await h.service.confirmPasswordReset(A, first, NEW_PASSWORD);
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');

  h.advance(MINUTE + 1);
  const second = await h.request(A);
  for (let i = 0; i < 5; i += 1)
    await failure(h.service.confirmPasswordReset(A, WRONG, 'Outra1-senha'));
  assert.deepEqual(
    await failure(h.service.confirmPasswordReset(A, second, 'Outra1-senha')),
    UNIFORM,
  );
  await assert.rejects(h.service.login(A, 'Outra1-senha'), UnauthorizedError);
  // O vencimento foi mantido: antes de 60 s do envio não sai código novo.
  h.advance(30_000);
  await h.service.requestPasswordReset(A);
  await h.service.drain();
  assert.equal(h.codeMails.length, 2);
  h.advance(31_000);
  const third = await h.request(A);
  assert.equal(h.accounts.peek(A).resetAttempts, 0);
  assert.notEqual(third, second);
});

test('teto diário: 10 erros em códigos novos matam o código vigente e o pedido deixa de emitir até a janela passar', async () => {
  const h = harness();
  await h.confirmed(A);
  let code = await h.request(A);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (let i = 0; i < 5; i += 1)
      await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD));
    h.advance(61_000);
    if (cycle === 0) code = await h.request(A);
  }
  assert.equal(h.accounts.peek(A).resetFailuresDay, 10);
  // O código novo foi morto pelo 10º erro; o certo não redefine e o pedido não emite.
  assert.deepEqual(await failure(h.service.confirmPasswordReset(A, code, NEW_PASSWORD)), UNIFORM);
  const sent = h.codeMails.length;
  await h.service.requestPasswordReset(A);
  await h.service.drain();
  assert.equal(h.codeMails.length, sent);
  // Passada a janela de 24 h (aberta no primeiro erro), o pedido volta; redefinir zera o contador.
  h.advance(24 * 60 * MINUTE);
  const fresh = await h.request(A);
  await h.service.confirmPasswordReset(A, fresh, NEW_PASSWORD);
  assert.equal(h.accounts.peek(A).resetFailuresDay, 0);
});

test('o hash da senha só é calculado depois de o código ser conferido; fila cheia = 503 e nada é gravado', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  const base = h.hasher.hashCalls;
  for (let i = 0; i < 3; i += 1)
    await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD));
  await failure(h.service.confirmPasswordReset('ninguem@example.test', WRONG, NEW_PASSWORD));
  assert.equal(h.hasher.hashCalls, base, 'código errado não gasta hash');
  h.flags.hashFails = true;
  const before = h.accounts.peek(A);
  await assert.rejects(
    h.service.confirmPasswordReset(A, code, NEW_PASSWORD),
    ServiceUnavailableError,
  );
  const after = h.accounts.peek(A);
  assert.equal(after.passwordHash, before.passwordHash);
  assert.equal(after.resetHash, before.resetHash);
  assert.equal(after.resetAttempts, before.resetAttempts);
  assert.equal(h.revokeCalls(), 0);
  h.flags.hashFails = false;
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
});

test('efeitos: revoga as sessões da conta antes e depois do commit, zera o bloqueio de login e não toca em outra conta', async () => {
  const h = harness();
  await h.confirmed(A);
  await h.confirmed(B);
  // Cinco senhas erradas bloqueiam o login da conta A (429).
  for (let i = 0; i < 5; i += 1)
    await assert.rejects(h.service.login(A, 'errada'), UnauthorizedError);
  await assert.rejects(h.service.login(A, PASSWORD), RateLimitError);
  const code = await h.request(A);
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
  const idA = h.accounts.peek(A).id;
  assert.deepEqual(h.revoked, [idA, idA]);
  assert.ok(!h.revoked.includes(h.accounts.peek(B).id));
  // O bloqueio por conta foi zerado: a nova senha entra na hora.
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');
  assert.equal(await h.service.login(B, PASSWORD), 'sessao');
});

test('Redis fora antes do commit: 503, senha e código intactos e repetir funciona', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  h.revokeFailures.add(1);
  const before = h.accounts.peek(A);
  await assert.rejects(
    h.service.confirmPasswordReset(A, code, NEW_PASSWORD),
    ServiceUnavailableError,
  );
  assert.equal(h.accounts.peek(A).passwordHash, before.passwordHash);
  assert.equal(h.accounts.peek(A).resetHash, before.resetHash);
  assert.equal(h.notices.length, 0);
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');
});

test('Redis fora depois do commit: 503 com a senha já trocada e o código gasto', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  h.revokeFailures.add(2);
  await assert.rejects(
    h.service.confirmPasswordReset(A, code, NEW_PASSWORD),
    ServiceUnavailableError,
  );
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');
  assert.deepEqual(await failure(h.service.confirmPasswordReset(A, code, NEW_PASSWORD)), UNIFORM);
  assert.deepEqual(
    h.attempts.map(([result]) => result),
    ['reset', 'revoke_failed', 'unavailable'],
  );
});

test('aviso de senha alterada: uma vez por redefinição, nunca por tentativa falha, sem o código; a falha dele não afeta a resposta', async () => {
  const h = harness();
  await h.confirmed(A);
  const code = await h.request(A);
  await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD));
  await h.service.drain();
  assert.equal(h.notices.length, 0);
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
  await h.service.drain();
  assert.deepEqual(h.notices, [A]);
  assert.equal(h.mailResults.at(-1), 'notice:sent');
  await failure(h.service.confirmPasswordReset(A, code, NEW_PASSWORD));
  await h.service.drain();
  assert.equal(h.notices.length, 1);
  // Falha do aviso: a redefinição responde normalmente.
  h.advance(MINUTE + 1);
  h.flags.noticeFails = true;
  const next = await h.request(A);
  await h.service.confirmPasswordReset(A, next, 'Terceira1-senha');
  await h.service.drain();
  assert.equal(h.notices.length, 1);
  assert.equal(h.mailResults.at(-1), 'notice:failed');
});

test('falha do SMTP no pedido: resposta igual, o código é apagado e um novo pedido sai na hora; drain espera o envio', async () => {
  const h = harness({ mailDelayMs: 20 });
  await h.confirmed(A);
  h.flags.codeMailFails = true;
  await h.service.requestPasswordReset(A);
  // O pedido responde antes do envio terminar; o drain espera.
  assert.equal(h.codeMails.length, 0);
  await h.service.drain();
  assert.equal(h.accounts.peek(A).resetHash, null);
  assert.equal(h.mailResults.at(-1), 'code:failed');
  h.flags.codeMailFails = false;
  await h.request(A);
  assert.equal(h.mailResults.at(-1), 'code:sent');
});

test('observador que falha não derruba o pedido nem a redefinição', async () => {
  const h = harness({ observerThrows: true });
  await h.confirmed(A);
  const code = await h.request(A);
  await failure(h.service.confirmPasswordReset(A, WRONG, NEW_PASSWORD));
  await h.service.confirmPasswordReset(A, code, NEW_PASSWORD);
  assert.equal(await h.service.login(A, NEW_PASSWORD), 'sessao');
});
