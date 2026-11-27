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

test('conta excluída (spec 045, E6): assunto fixo, texto simples sem link nem código', async () => {
  const { sent, mailer } = capture();
  await mailer.sendAccountDeleted('recipient@example.test');
  const message = sent[0];
  assert.ok(message);
  assert.equal(message.to, 'recipient@example.test');
  assert.equal(message.subject, 'Sua conta do Soprei foi excluída');
  assert.equal(message.html, undefined);
  assert.ok(typeof message.text === 'string' && message.text.length > 0);
  assert.doesNotMatch(message.text, /https?:|[0-9]{6}|recipient/);
});

test('falha do transporte vira ServiceUnavailableError fixo, sem cause, e-mail, código nem texto da falha', async () => {
  const mailer = new SmtpVerificationMailer(BASE, {
    sendMail: () =>
      Promise.reject(new Error('falha host-secreto recipient@example.test 535 5.7.8')),
  });
  for (const send of [
    () => mailer.sendPasswordReset('recipient@example.test', '482913'),
    () => mailer.sendPasswordChanged('recipient@example.test'),
    () => mailer.sendAccountDeleted('recipient@example.test'),
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

test('convite: assunto fixo sem nome de empresa, texto simples, link em linha própria e erro fixo na falha', async () => {
  const { sent, mailer } = capture();
  const link = 'https://app.exemplo.test/convite#t=token-secreto';
  await mailer.sendCompanyInvitation('convidada@example.test', {
    companyName: 'Padaria Boa',
    role: 'VIEWER',
    link,
    validDays: 7,
  });
  const message = sent[0];
  assert.ok(message);
  assert.equal(message.to, 'convidada@example.test');
  assert.equal(message.subject, 'Você recebeu um convite para o Soprei');
  assert.ok(!(message.subject ?? '').includes('Padaria'));
  assert.equal(message.html, undefined);
  assert.ok(typeof message.text === 'string');
  assert.ok(message.text.split(NL).includes(link));
  assert.ok(message.text.includes('"Padaria Boa"'));

  const failing = new SmtpVerificationMailer(BASE, {
    sendMail: () => Promise.reject(new Error('550 convidada@example.test token-secreto')),
  });
  await assert.rejects(
    failing.sendCompanyInvitation('convidada@example.test', {
      companyName: 'Padaria Boa',
      role: 'VIEWER',
      link,
      validDays: 7,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.ok(!error.message.includes('convidada'));
      assert.ok(!error.message.includes('token-secreto'));
      assert.ok(!error.message.includes('Padaria'));
      return true;
    },
  );
});

test('aviso de cobrança: texto simples sem HTML; a falha vira erro fixo, sem eco do destinatário nem do texto', async () => {
  const { sent, mailer } = capture();
  await mailer.sendBillingNotice('titular@example.test', {
    subject: 'Assunto fixo',
    text: 'Corpo do aviso',
  });
  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.ok(message);
  assert.equal(message.to, 'titular@example.test');
  assert.equal(message.subject, 'Assunto fixo');
  assert.equal(message.text, 'Corpo do aviso');
  assert.equal(message.html, undefined);

  const failing = new SmtpVerificationMailer(BASE, {
    sendMail: (options) => Promise.reject(new Error(`recusou ${JSON.stringify(options.to)}`)),
  });
  await assert.rejects(
    failing.sendBillingNotice('titular@example.test', { subject: 'S', text: 'segredo-do-texto' }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.message, 'Não foi possível enviar o aviso de cobrança.');
      assert.ok(!JSON.stringify(error).includes('titular@example.test'));
      assert.ok(!JSON.stringify(error).includes('segredo-do-texto'));
      return true;
    },
  );
});
