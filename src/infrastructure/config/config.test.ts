import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from './parse-config.js';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('parseConfig', () => {
  it('aplica defaults e converte PORT para número', () => {
    const result = parseConfig({ ...VALID_ENV, PORT: '8080' });
    assert.ok(result.ok);
    assert.equal(result.value.PORT, 8080);
    assert.equal(typeof result.value.PORT, 'number');
    assert.equal(result.value.NODE_ENV, 'development');
    assert.equal(result.value.LOG_LEVEL, 'info');
    assert.equal(result.value.HOST, '0.0.0.0');
  });

  it('falha citando DATABASE_URL quando ausente', () => {
    const result = parseConfig({ REDIS_URL: VALID_ENV.REDIS_URL });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /DATABASE_URL/);
    assert.match(result.error.message, /obrigatória ausente/);
  });

  it('falha quando PORT não é numérica', () => {
    const result = parseConfig({ ...VALID_ENV, PORT: 'abc' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /PORT/);
  });

  it('falha quando DATABASE_URL não é postgres', () => {
    const result = parseConfig({ ...VALID_ENV, DATABASE_URL: 'mysql://x' });
    assert.equal(result.ok, false);
  });

  describe('REDIS_URL', () => {
    it('falha com mensagem clara quando ausente', () => {
      const result = parseConfig({ DATABASE_URL: VALID_ENV.DATABASE_URL });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /REDIS_URL/);
      assert.match(result.error.message, /obrigatória ausente/);
    });

    it('falha quando não é redis:// nem rediss://', () => {
      const result = parseConfig({ ...VALID_ENV, REDIS_URL: 'http://localhost:6379' });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /REDIS_URL/);
    });

    it('aceita rediss:// (TLS)', () => {
      const result = parseConfig({ ...VALID_ENV, REDIS_URL: 'rediss://host:6380/0' });
      assert.ok(result.ok);
    });
  });

  describe('pool do PostgreSQL', () => {
    it('aplica os defaults', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      assert.equal(result.value.DB_POOL_MAX, 10);
      assert.equal(result.value.DB_POOL_IDLE_TIMEOUT_MS, 30_000);
      assert.equal(result.value.DB_POOL_CONNECTION_TIMEOUT_MS, 5_000);
      assert.equal(result.value.DB_STATEMENT_TIMEOUT_MS, 30_000);
    });

    it('converte strings para número', () => {
      const result = parseConfig({
        ...VALID_ENV,
        DB_POOL_MAX: '25',
        DB_POOL_IDLE_TIMEOUT_MS: '1000',
        DB_POOL_CONNECTION_TIMEOUT_MS: '2000',
        DB_STATEMENT_TIMEOUT_MS: '3000',
      });
      assert.ok(result.ok);
      assert.equal(result.value.DB_POOL_MAX, 25);
      assert.equal(result.value.DB_POOL_IDLE_TIMEOUT_MS, 1000);
      assert.equal(result.value.DB_POOL_CONNECTION_TIMEOUT_MS, 2000);
      assert.equal(result.value.DB_STATEMENT_TIMEOUT_MS, 3000);
    });

    const invalid: readonly (readonly [string, string])[] = [
      ['DB_POOL_MAX', '0'],
      ['DB_POOL_MAX', '-1'],
      ['DB_POOL_MAX', '201'],
      ['DB_POOL_MAX', '2.5'],
      ['DB_POOL_MAX', 'muitos'],
      ['DB_POOL_IDLE_TIMEOUT_MS', '0'],
      ['DB_POOL_IDLE_TIMEOUT_MS', '3600001'],
      ['DB_POOL_CONNECTION_TIMEOUT_MS', '-5'],
      ['DB_POOL_CONNECTION_TIMEOUT_MS', '120001'],
      ['DB_STATEMENT_TIMEOUT_MS', '0'],
      ['DB_STATEMENT_TIMEOUT_MS', '600001'],
    ];
    for (const [name, value] of invalid) {
      it(`rejeita ${name}=${value}`, () => {
        const result = parseConfig({ ...VALID_ENV, [name]: value });
        assert.equal(result.ok, false);
        assert.match(result.error.message, new RegExp(name));
      });
    }
  });
});
