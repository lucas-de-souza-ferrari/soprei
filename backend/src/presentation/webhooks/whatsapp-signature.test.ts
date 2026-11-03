import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { signWebhookBody } from '../../test-support/whatsapp-payloads.js';
import { secretsMatch, verifyWhatsappSignature } from './whatsapp-signature.js';

const SECRET = 'segredo-do-app-meta-12345';
const BODY = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe('verifyWhatsappSignature', () => {
  it('aceita o HMAC-SHA256 hexadecimal dos bytes crus, com o prefixo sha256=', () => {
    assert.equal(verifyWhatsappSignature(BODY, signWebhookBody(BODY, SECRET), SECRET), true);
  });

  it('aceita hexadecimal em maiúsculas (é o mesmo valor)', () => {
    const header = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex').toUpperCase()}`;
    assert.equal(verifyWhatsappSignature(BODY, header, SECRET), true);
  });

  it('recusa cabeçalho ausente, repetido (array), vazio e sem o prefixo', () => {
    const good = signWebhookBody(BODY, SECRET);
    assert.equal(verifyWhatsappSignature(BODY, undefined, SECRET), false);
    assert.equal(verifyWhatsappSignature(BODY, [good, good], SECRET), false);
    assert.equal(verifyWhatsappSignature(BODY, '', SECRET), false);
    assert.equal(verifyWhatsappSignature(BODY, good.slice('sha256='.length), SECRET), false);
    assert.equal(verifyWhatsappSignature(BODY, good.replace('sha256=', 'sha1='), SECRET), false);
    assert.equal(verifyWhatsappSignature(BODY, ` ${good}`, SECRET), false);
  });

  it('recusa tamanho errado e hexadecimal malformado (sem lançar)', () => {
    const good = signWebhookBody(BODY, SECRET);
    for (const header of [
      good.slice(0, -2),
      `${good}00`,
      'sha256=',
      `sha256=${'z'.repeat(64)}`,
      `sha256=${'0'.repeat(63)}`,
      `sha256=${'0'.repeat(65)}`,
    ]) {
      assert.equal(verifyWhatsappSignature(BODY, header, SECRET), false, header);
    }
  });

  it('recusa assinatura calculada com outro segredo e assinatura de outro corpo', () => {
    assert.equal(
      verifyWhatsappSignature(BODY, signWebhookBody(BODY, 'outro-segredo'), SECRET),
      false,
    );
    assert.equal(
      verifyWhatsappSignature(BODY, signWebhookBody(Buffer.from('{}'), SECRET), SECRET),
      false,
    );
  });

  it('é sobre os bytes crus: o mesmo JSON com espaços diferentes não passa com a assinatura do original', () => {
    const original = Buffer.from('{"a":1,"b":2}');
    const reformatted = Buffer.from('{ "a": 1, "b": 2 }');
    const signature = signWebhookBody(original, SECRET);
    assert.equal(verifyWhatsappSignature(original, signature, SECRET), true);
    assert.equal(verifyWhatsappSignature(reformatted, signature, SECRET), false);
  });

  it('corpo com bytes não UTF-8 também é conferido sobre os bytes (não sobre texto decodificado)', () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x7d]);
    assert.equal(verifyWhatsappSignature(binary, signWebhookBody(binary, SECRET), SECRET), true);
    assert.equal(
      verifyWhatsappSignature(binary, signWebhookBody(binary.toString('utf8'), SECRET), SECRET),
      false,
    );
  });
});

describe('secretsMatch', () => {
  it('compara em tempo constante: iguais passam; diferentes, prefixo, vazio e tamanhos distintos não', () => {
    assert.equal(secretsMatch('token-de-verificacao', 'token-de-verificacao'), true);
    assert.equal(secretsMatch('token-de-verificacao', 'token-de-verificacaO'), false);
    assert.equal(secretsMatch('token', 'token-de-verificacao'), false);
    assert.equal(secretsMatch('token-de-verificacao-extra', 'token-de-verificacao'), false);
    assert.equal(secretsMatch('', 'token-de-verificacao'), false);
    assert.equal(secretsMatch('', ''), true);
  });
});
