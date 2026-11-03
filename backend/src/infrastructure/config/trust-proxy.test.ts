import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTrustProxy } from './trust-proxy.js';

function parsed(raw: string | undefined): unknown {
  const result = parseTrustProxy(raw);
  assert.ok(result.ok, result.ok ? '' : result.message);
  return result.value;
}

describe('parseTrustProxy', () => {
  it('ausente ou vazio vale false (padrão seguro)', () => {
    assert.equal(parsed(undefined), false);
    assert.equal(parsed(''), false);
    assert.equal(parsed('  '), false);
  });

  it('aceita false e true literais', () => {
    assert.equal(parsed('false'), false);
    assert.equal(parsed('true'), true);
  });

  it('rejeita inteiro (o Fastify não confia em contagem de saltos), com a dica da lista', () => {
    for (const raw of ['0', '1', '2', '32', '33', '999']) {
      const result = parseTrustProxy(raw);
      assert.ok(!result.ok, raw);
      assert.match(result.message, /liste os IPs[/]CIDRs/);
    }
  });

  it('aceita lista de IPs e CIDRs (IPv4 e IPv6), ignorando espaços', () => {
    assert.deepEqual(parsed('10.0.0.1, 192.168.0.0/16 ,::1,fd00::/8'), [
      '10.0.0.1',
      '192.168.0.0/16',
      '::1',
      'fd00::/8',
    ]);
    assert.deepEqual(parsed('127.0.0.1'), ['127.0.0.1']);
  });

  it('rejeita lixo, palavras-chave, prefixo inválido, entrada vazia e confiança total disfarçada', () => {
    const invalid = [
      'yes',
      'TRUE',
      'loopback',
      '-1',
      '1.5',
      '10.0.0.1/33',
      '::1/129',
      '10.0.0.1/abc',
      '10.0.0.0/0',
      '::/0',
      '10.0.0.1,,10.0.0.2',
      '10.0.0.1,',
      'example.com',
      '999.1.1.1',
    ];
    for (const raw of invalid) {
      assert.equal(parseTrustProxy(raw).ok, false, raw);
    }
  });
});
