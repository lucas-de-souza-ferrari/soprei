import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRequestContext,
  runWithContext,
  setClientId,
  setOperation,
  setUserId,
} from '../../shared/request-context/index.js';
import { captureLogs } from '../../test-support/log-capture.js';

describe('createLogger', () => {
  it('fora de requisição (boot, shutdown) o mixin não acrescenta nada e não falha', () => {
    const capture = captureLogs();
    capture.logger.info({ evento: 'boot' }, 'sem contexto');
    const [line] = capture.lines();
    assert.ok(line);
    assert.equal(line.evento, 'boot');
    for (const key of ['requestId', 'clientId', 'userId', 'operation']) {
      assert.equal(Object.hasOwn(line, key), false, key);
    }
  });

  it('dentro de uma requisição, o logger raiz acrescenta requestId e o que estiver definido', () => {
    const capture = captureLogs();
    runWithContext(createRequestContext('req-1234567'), () => {
      capture.logger.info('só requestId');
      setClientId('c1');
      setUserId('u1');
      setOperation('GET /x');
      capture.logger.info('completo');
    });
    const [first, second] = capture.lines();
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.requestId, 'req-1234567');
    assert.equal(Object.hasOwn(first, 'clientId'), false);
    assert.equal(second.requestId, 'req-1234567');
    assert.equal(second.clientId, 'c1');
    assert.equal(second.userId, 'u1');
    assert.equal(second.operation, 'GET /x');
  });

  it('um logger filho que já tem requestId nos bindings não o repete', () => {
    const capture = captureLogs();
    const child = capture.logger.child({ requestId: 'req-1234567' });
    runWithContext(createRequestContext('req-1234567'), () => {
      setClientId('c1');
      child.info('filho');
    });
    const raw = capture.raw();
    assert.equal(raw.split('"requestId"').length - 1, 1, raw);
    assert.equal(capture.lines()[0]?.clientId, 'c1');
  });

  it('o nível configurado é respeitado e o destino recebe só JSON', () => {
    const capture = captureLogs('warn');
    capture.logger.info('ignorado');
    capture.logger.warn('visível');
    assert.equal(capture.lines().length, 1);
  });

  it('segredos de autenticação (spec 007) saem como [Redacted], na raiz e aninhados', () => {
    const capture = captureLogs();
    const logger = capture.logger;
    const keys = ['passwordHash', 'newPassword', 'currentPassword', 'JWT_SECRET', 'email'];
    const secrets = Object.fromEntries(keys.map((key, i) => [key, `segredo-auth-${String(i)}`]));
    logger.info({ ...secrets, visivel: 'ok' }, 'raiz');
    logger.info({ dados: secrets, visivel: 'ok' }, 'aninhado');
    assert.ok(!capture.raw().includes('segredo-auth-'), capture.raw());
    const [root, nested] = capture.lines();
    for (const key of keys) {
      assert.equal(root?.[key], '[Redacted]', key);
      assert.equal((nested?.dados as Record<string, unknown>)[key], '[Redacted]', key);
    }
  });

  it('credenciais do canal (spec 015): oauthCode, PIN e texto cifrado saem como [Redacted]; code genérico não', () => {
    const capture = captureLogs();
    capture.logger.info(
      {
        oauthCode: 'codigo-secreto-1',
        registrationPin: '123456',
        registrationPinCiphertext: 'v1.k.pin-cifrado',
        tokenCiphertext: 'v1.k.token-cifrado',
        aninhado: { oauthCode: 'codigo-secreto-2' },
        code: 'CHANNEL_NUMBER_IN_USE',
      },
      'canal',
    );
    const raw = capture.raw();
    for (const secret of [
      'codigo-secreto-1',
      'codigo-secreto-2',
      '123456',
      'pin-cifrado',
      'token-cifrado',
    ]) {
      assert.ok(!raw.includes(secret), secret);
    }
    // `code` é o código de erro útil, que não deve ser mascarado.
    assert.ok(raw.includes('CHANNEL_NUMBER_IN_USE'));
  });
});
