import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SendMailOptions } from 'nodemailer';
import { GmailVerificationMailer } from './gmail-verification-mailer.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';

test('envia confirmação com remetente configurado e código em linhas separadas', async () => {
  const sent: SendMailOptions[] = [];
  const mailer = new GmailVerificationMailer('sender@example.test', 'fake-password', {
    sendMail: (options) => {
      sent.push(options);
      return Promise.resolve({});
    },
  });
  await mailer.sendVerification('recipient@example.test', 'secret-code');
  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.ok(message);
  assert.equal(message.from, 'sender@example.test');
  assert.equal(message.to, 'recipient@example.test');
  assert.ok(typeof message.text === 'string');
  assert.ok(message.text.includes(String.fromCharCode(10, 10) + 'secret-code'));
});

test('não propaga destinatário ou corpo do erro SMTP', async () => {
  const mailer = new GmailVerificationMailer('sender@example.test', 'fake-password', {
    sendMail: () => Promise.reject(new Error('segredo SMTP recipient@example.test')),
  });
  await assert.rejects(
    mailer.sendVerification('recipient@example.test', 'code'),
    (error) =>
      error instanceof ServiceUnavailableError &&
      !error.message.includes('segredo') &&
      !error.message.includes('recipient') &&
      error.cause === undefined,
  );
});
