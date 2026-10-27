import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientIpOf, normalizeClientIp, UNKNOWN_CLIENT_IP } from './client-ip.js';

describe('normalizeClientIp', () => {
  it('IPv4 comum fica como está', () => {
    assert.equal(normalizeClientIp('203.0.113.7'), '203.0.113.7');
  });

  it('IPv4 mapeado em IPv6 vira o IPv4 (mesma chave dos dois jeitos)', () => {
    assert.equal(normalizeClientIp('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(normalizeClientIp('::FFFF:203.0.113.7'), normalizeClientIp('203.0.113.7'));
    assert.equal(normalizeClientIp('::ffff:cb00:7107'), '203.0.113.7');
  });

  it('IPv6 do mesmo /64 compartilha a chave; de /64 diferente, não', () => {
    const a = normalizeClientIp('2001:db8:aaaa:bbbb:1:2:3:4');
    const b = normalizeClientIp('2001:db8:aaaa:bbbb:ffff:eeee:dddd:cccc');
    const c = normalizeClientIp('2001:db8:aaaa:bbbc:1:2:3:4');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a, '2001:db8:aaaa:bbbb::');
  });

  it('IPv6 com letras maiúsculas e zeros à esquerda equivale à forma canônica', () => {
    assert.equal(
      normalizeClientIp('2001:0DB8:AAAA:BBBB:0000:0000:0000:0001'),
      normalizeClientIp('2001:db8:aaaa:bbbb::1'),
    );
  });

  it('remove porta e colchetes antes de normalizar', () => {
    assert.equal(normalizeClientIp('203.0.113.7:51234'), '203.0.113.7');
    assert.equal(normalizeClientIp('[2001:db8:aaaa:bbbb::1]:443'), '2001:db8:aaaa:bbbb::');
    assert.equal(normalizeClientIp('[2001:db8:aaaa:bbbb::1]'), '2001:db8:aaaa:bbbb::');
  });

  it('remove a zona do IPv6 (fe80::1%eth0) sem lançar', () => {
    assert.equal(normalizeClientIp('fe80::1%eth0'), normalizeClientIp('fe80::1'));
    assert.equal(normalizeClientIp('fe80::1%25eth0'), normalizeClientIp('fe80::1'));
  });

  it('o que não é IP vira "unknown", sem lançar', () => {
    for (const raw of [
      undefined,
      '',
      'garbage',
      '1.2.3',
      '999.1.1.1',
      '::g',
      'a, b',
      '[::1',
      ' ',
    ]) {
      assert.equal(normalizeClientIp(raw), UNKNOWN_CLIENT_IP, String(raw));
    }
  });
});

describe('clientIpOf', () => {
  it('usa request.ip quando ele é um IP', () => {
    assert.equal(
      clientIpOf({ ip: '203.0.113.7', socket: { remoteAddress: '10.0.0.1' } }),
      '203.0.113.7',
    );
  });

  it('cai no endereço do socket quando request.ip não é utilizável (X-Forwarded-For malformado)', () => {
    assert.equal(
      clientIpOf({ ip: 'garbage', socket: { remoteAddress: '::ffff:10.0.0.1' } }),
      '10.0.0.1',
    );
  });

  it('sem nenhum dos dois, "unknown"', () => {
    assert.equal(clientIpOf({ ip: '', socket: {} }), UNKNOWN_CLIENT_IP);
  });
});
