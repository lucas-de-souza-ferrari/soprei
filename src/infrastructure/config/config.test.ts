import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from './parse-config.js';

const VALID_ENV = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

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
    const result = parseConfig({});
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
    const result = parseConfig({ DATABASE_URL: 'mysql://x' });
    assert.equal(result.ok, false);
  });
});
