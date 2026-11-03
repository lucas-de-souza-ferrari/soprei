import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SendMailOptions } from 'nodemailer';
import { SmtpVerificationMailer, type SmtpMailerOptions } from './smtp-verification-mailer.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';

const NL = String.fromCharCode(10);
const BASE: SmtpMailerOptions = {
  host: 'mail.example.test',
  port: 587,
  secure: false,
  requireTLS: true,
  from: 'noreply@example.test',
};

function capture() {
  const sent: SendMailOptions[] = [];
  const mailer = new SmtpVerificationMailer(BASE, {
    sendMail: (options) => {
      sent.push(options);
      return Promise.resolve({});
    },
  });
  return { sent, mailer };
}

test('código de recuperação: assunto próprio sem o código, texto simples, código em linha própria e 15 minutos', async () => {
  const { sent, mailer } = capture();
  await mailer.sendPasswordReset('recipient@example.test', '482913');
  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.ok(message);
  assert.deepEqual(message.from, { name: 'Soprei', address: 'noreply@example.test' });
  assert.equal(message.to, 'recipient@example.test');
  assert.equal(message.subject, 'Seu código para redefinir a senha do Soprei');
  assert.ok(!(message.subject ?? '').includes('482913'));
  // Assunto distinto do e-mail de confirmação.
  assert.notEqual(message.subject, 'Seu código de confirmação do Soprei');
  assert.equal(message.html, undefined);
  assert.ok(typeof message.text === 'string');
  assert.deepEqual(message.text.split(NL), [
    'Seu código para redefinir a senha é:',
    '',
    '482913',
    '',
    'Ele vale por 15 minutos. Se você não pediu isso, ignore esta mensagem; sua senha continua a mesma.',
  ]);
  assert.ok(message.text.split(NL).includes('482913'));
});

test('aviso de senha alterada: sem código, senha, IP nem link', async () => {
  const { sent, mailer } = capture();
  await mailer.sendPasswordChanged('recipient@example.test');
  const message = sent[0];
  assert.ok(message);
  assert.equal(message.to, 'recipient@example.test');
  assert.equal(message.subject, 'Sua senha do Soprei foi alterada');
  assert.equal(message.html, undefined);
  assert.ok(typeof message.text === 'string');
  assert.equal(
    message.text,
    'A senha da sua conta foi alterada e todas as sessões abertas foram encerradas. Se foi você, não precisa fazer nada. Se não foi, redefina a senha de novo e confira o acesso ao seu e-mail.',
  );
  assert.doesNotMatch(message.text, /https?:|[0-9]{6}/);
});

test('falha do transporte vira ServiceUnavailableError fixo, sem cause, e-mail, código nem texto da falha', async () => {
  const mailer = new SmtpVerificationMailer(BASE, {
    sendMail: () =>
      Promise.reject(new Error('falha host-secreto recipient@example.test 535 5.7.8')),
  });
  for (const send of [
    () => mailer.sendPasswordReset('recipient@example.test', '482913'),
    () => mailer.sendPasswordChanged('recipient@example.test'),
  ]) {
    await assert.rejects(send(), (error) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.cause, undefined);
      const dump = JSON.stringify({ message: error.message, context: error.context });
      for (const secret of ['host-secreto', 'recipient', '535', '482913']) {
        assert.ok(!dump.includes(secret), secret);
      }
      return true;
    });
  }
});
