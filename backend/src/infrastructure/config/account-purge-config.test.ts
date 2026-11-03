import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseConfig } from './parse-config.js';
import { REDACT_PATHS } from '../logger/logger.js';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SECRET: 'j'.repeat(32),
};

function value(env: NodeJS.ProcessEnv) {
  const result = parseConfig({ ...BASE, ...env });
  assert.ok(result.ok, 'configuração deveria ser válida');
  return result.value;
}
function refused(env: NodeJS.ProcessEnv): string {
  const result = parseConfig({ ...BASE, ...env });
  if (result.ok) assert.fail('esperava falha de config');
  return result.error.message;
}

describe('config do expurgo de contas não confirmadas (spec 021)', () => {
  it('padrões: 7 dias de retenção e varredura a cada 60 minutos', () => {
    const config = value({});
    assert.equal(config.ACCOUNT_UNVERIFIED_RETENTION_DAYS, 7);
    assert.equal(config.ACCOUNT_PURGE_INTERVAL_MINUTES, 60);
  });

  it('aceita os limites e recusa retenção fora de 1 a 90 e intervalo fora de 0 a 1440', () => {
    assert.equal(
      value({ ACCOUNT_UNVERIFIED_RETENTION_DAYS: '1' }).ACCOUNT_UNVERIFIED_RETENTION_DAYS,
      1,
    );
    assert.equal(
      value({ ACCOUNT_UNVERIFIED_RETENTION_DAYS: '90' }).ACCOUNT_UNVERIFIED_RETENTION_DAYS,
      90,
    );
    assert.equal(value({ ACCOUNT_PURGE_INTERVAL_MINUTES: '0' }).ACCOUNT_PURGE_INTERVAL_MINUTES, 0);
    assert.equal(
      value({ ACCOUNT_PURGE_INTERVAL_MINUTES: '1440' }).ACCOUNT_PURGE_INTERVAL_MINUTES,
      1440,
    );
    for (const days of ['0', '91', '-1', '1.5', 'abc']) {
      assert.match(
        refused({ ACCOUNT_UNVERIFIED_RETENTION_DAYS: days }),
        /ACCOUNT_UNVERIFIED_RETENTION_DAYS/,
      );
    }
    for (const minutes of ['-1', '1441', '2.5', 'abc']) {
      assert.match(
        refused({ ACCOUNT_PURGE_INTERVAL_MINUTES: minutes }),
        /ACCOUNT_PURGE_INTERVAL_MINUTES/,
      );
    }
  });

  it('o .env.example documenta as duas variáveis com valores válidos', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    assert.match(example, /^ACCOUNT_UNVERIFIED_RETENTION_DAYS=7$/m);
    assert.match(example, /^ACCOUNT_PURGE_INTERVAL_MINUTES=60$/m);
    value({ ACCOUNT_UNVERIFIED_RETENTION_DAYS: '7', ACCOUNT_PURGE_INTERVAL_MINUTES: '60' });
  });

  it('resetHash está no redact do logger', () => {
    assert.ok(REDACT_PATHS.includes('resetHash'));
    assert.ok(REDACT_PATHS.includes('*.resetHash'));
  });
});
