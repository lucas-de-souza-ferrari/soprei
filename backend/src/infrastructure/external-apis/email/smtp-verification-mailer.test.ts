import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SendMailOptions } from 'nodemailer';
import {
  buildTransportOptions,
  SmtpVerificationMailer,
  type SmtpMailerOptions,
} from './smtp-verification-mailer.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';
import { captureLogs } from '../../../test-support/log-capture.js';

const NL = String.fromCharCode(10);
const BASE: SmtpMailerOptions = {
  host: 'mail.example.test',
  port: 587,
  secure: false,
  requireTLS: true,
  from: 'noreply@example.test',
};

test('envia o código de 6 dígitos em linha própria, com 15 minutos e sem o código no assunto', async () => {
  const sent: SendMailOptions[] = [];
  const mailer = new SmtpVerificationMailer(BASE, {
    sendMail: (options) => {
      sent.push(options);
      return Promise.resolve({});
    },
  });
  await mailer.sendVerification('recipient@example.test', '482913');
  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.ok(message);
  assert.deepEqual(message.from, { name: 'Soprei', address: 'noreply@example.test' });
  assert.equal(message.to, 'recipient@example.test');
  assert.equal(message.subject, 'Seu código de confirmação do Soprei');
  assert.ok(!(message.subject ?? '').includes('482913'));
  assert.ok(typeof message.text === 'string');
  // Texto simples: sem HTML, o código sozinho em uma linha (6 dígitos contínuos).
  assert.equal(message.html, undefined);
  assert.deepEqual(message.text.split(NL), [
    'Seu código de confirmação é:',
    '',
    '482913',
    '',
    'Ele vale por 15 minutos. Se você não pediu este cadastro, ignore esta mensagem.',
  ]);
  assert.ok(message.text.split(NL).includes('482913'));
});

test('auth só vai ao transporte com usuário e senha', () => {
  assert.equal('auth' in buildTransportOptions(BASE), false);
  const withAuth = buildTransportOptions({ ...BASE, auth: { user: 'u', pass: 'p' } });
  assert.deepEqual(withAuth.auth, { user: 'u', pass: 'p' });
});

test('opções do transporte: timeouts fixos, sem log e requireTLS conforme a decisão', () => {
  const options = buildTransportOptions(BASE);
  assert.equal(options.connectionTimeout, 5000);
  assert.equal(options.greetingTimeout, 5000);
  assert.equal(options.socketTimeout, 10000);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.requireTLS, true);
  assert.equal(buildTransportOptions({ ...BASE, requireTLS: false }).requireTLS, false);
  assert.equal(options.tls, undefined);
});

test('falha de envio: erro fixo, sem cause e sem host, usuário, senha, destinatário nem texto', async () => {
  const secrets = ['host-secreto.example.test', 'usuario-secreto', 'senha-secreta'];
  const mailer = new SmtpVerificationMailer(
    { ...BASE, host: secrets[0] ?? '', auth: { user: secrets[1] ?? '', pass: secrets[2] ?? '' } },
    {
      sendMail: () =>
        Promise.reject(
          new Error(`falha ${secrets.join(' ')} recipient@example.test 535 5.7.8 resposta`),
        ),
    },
  );
  await assert.rejects(mailer.sendVerification('recipient@example.test', '482913'), (error) => {
    assert.ok(error instanceof ServiceUnavailableError);
    assert.equal(error.cause, undefined);
    const dump = JSON.stringify({ message: error.message, context: error.context });
    for (const secret of [...secrets, 'recipient', '535', 'resposta', '482913']) {
      assert.ok(!dump.includes(secret), secret);
      assert.ok(!error.message.includes(secret), secret);
    }
    return true;
  });
});

test('log de falha e de sucesso do envio nunca expõe usuário nem senha SMTP', async () => {
  const user = 'sentinela-usuario-smtp';
  const pass = 'sentinela-senha-smtp';
  const capture = captureLogs();
  const config = { EMAIL_PROVIDER_USER: user, EMAIL_PROVIDER_PSWD: pass, host: 'h' };
  capture.logger.info({ config }, 'config');
  capture.logger.info(config, 'config na raiz');
  for (const fail of [true, false]) {
    const mailer = new SmtpVerificationMailer(
      { ...BASE, auth: { user, pass } },
      {
        sendMail: () => (fail ? Promise.reject(new Error(`${user} ${pass}`)) : Promise.resolve({})),
      },
    );
    try {
      await mailer.sendVerification('a@example.test', 'code');
      capture.logger.info({ accountId: 'x', result: 'sent' }, 'confirmação de e-mail enviada');
    } catch {
      capture.logger.warn({ accountId: 'x', result: 'failed' }, 'falha ao enviar confirmação');
    }
  }
  assert.ok(!capture.raw().includes(user));
  assert.ok(!capture.raw().includes(pass));
  assert.ok(capture.raw().includes('[Redacted]'));
});
