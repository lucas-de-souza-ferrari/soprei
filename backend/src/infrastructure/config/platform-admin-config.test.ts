import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { REDACT_PATHS } from '../logger/logger.js';
import { parseConfig } from './parse-config.js';

const KEY = Buffer.alloc(32, 9).toString('base64url');
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SECRET: 'j'.repeat(32),
};
const ENABLED = {
  PLATFORM_ADMIN_ENABLED: 'true',
  ADMIN_ORIGIN: 'https://soadm.exemplo.test',
  PLATFORM_TOTP_KEYS: `k1:${KEY}`,
  PLATFORM_TOTP_ACTIVE_KEY_ID: 'k1',
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

describe('config do admin da plataforma (spec 044, E1)', () => {
  it('desligado por padrão, sem exigir nada; sessão com 30 min ociosa e 12 h de teto', () => {
    const config = value({});
    assert.equal(config.PLATFORM_ADMIN_ENABLED, false);
    assert.equal(config.PLATFORM_SESSION_IDLE_SECONDS, 1_800);
    assert.equal(config.PLATFORM_SESSION_MAX_SECONDS, 43_200);
  });

  it('ligado com tudo certo é aceito', () => {
    const config = value(ENABLED);
    assert.equal(config.PLATFORM_ADMIN_ENABLED, true);
    assert.equal(config.ADMIN_ORIGIN, 'https://soadm.exemplo.test');
  });

  it('ligado sem origem ou sem as chaves do segundo fator: recusa o boot', () => {
    for (const missing of ['ADMIN_ORIGIN', 'PLATFORM_TOTP_KEYS', 'PLATFORM_TOTP_ACTIVE_KEY_ID']) {
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(ENABLED).filter(([name]) => name !== missing),
      );
      assert.match(refused(env), new RegExp(missing), missing);
    }
  });

  it('origem: exata, HTTPS em produção e diferente da do site', () => {
    for (const origin of ['soadm.exemplo.test', 'https://soadm.exemplo.test/', 'ftp://x.test']) {
      assert.match(refused({ ...ENABLED, ADMIN_ORIGIN: origin }), /ADMIN_ORIGIN/, origin);
    }
    assert.match(
      refused({ ...ENABLED, NODE_ENV: 'production', ADMIN_ORIGIN: 'http://soadm.exemplo.test' }),
      /ADMIN_ORIGIN/,
    );
    assert.match(
      refused({ ...ENABLED, APP_ORIGIN: 'https://soadm.exemplo.test' }),
      /diferente de APP_ORIGIN/,
    );
    assert.equal(
      value({ ...ENABLED, ADMIN_ORIGIN: 'http://127.0.0.1:5175' }).ADMIN_ORIGIN,
      'http://127.0.0.1:5175',
    );
  });

  it('chaves malformadas ou chave ativa fora da lista: recusa sem ecoar a chave', () => {
    const bad = refused({ ...ENABLED, PLATFORM_TOTP_KEYS: 'k1:curta' });
    assert.match(bad, /PLATFORM_TOTP_KEYS/);
    assert.equal(bad.includes('curta'), false);
    const inactive = refused({ ...ENABLED, PLATFORM_TOTP_ACTIVE_KEY_ID: 'k2' });
    assert.match(inactive, /PLATFORM_TOTP_ACTIVE_KEY_ID/);
    assert.equal(inactive.includes(KEY), false);
  });

  it('desligado: chaves presentes também são conferidas (a CLI monta a cifra com elas)', () => {
    const off = { PLATFORM_TOTP_KEYS: `k1:${KEY}`, PLATFORM_TOTP_ACTIVE_KEY_ID: 'k1' };
    assert.equal(value(off).PLATFORM_ADMIN_ENABLED, false);
    const bad = refused({ ...off, PLATFORM_TOTP_KEYS: 'k1:curta' });
    assert.match(bad, /PLATFORM_TOTP_KEYS/);
    assert.equal(bad.includes('curta'), false);
    assert.match(
      refused({ ...off, PLATFORM_TOTP_ACTIVE_KEY_ID: 'k2' }),
      /PLATFORM_TOTP_ACTIVE_KEY_ID/,
    );
  });

  it('teto da sessão menor que o prazo ocioso é recusado', () => {
    assert.match(
      refused({
        ...ENABLED,
        PLATFORM_SESSION_IDLE_SECONDS: '3600',
        PLATFORM_SESSION_MAX_SECONDS: '1800',
      }),
      /PLATFORM_SESSION_MAX_SECONDS/,
    );
  });

  it('segredos do segundo fator e da sessão estão no redact e as variáveis no .env.example', () => {
    for (const key of [
      'totpSecret',
      'totpSecretCiphertext',
      'PLATFORM_TOTP_KEYS',
      'platformSession',
    ]) {
      assert.ok(REDACT_PATHS.includes(key), key);
      assert.ok(REDACT_PATHS.includes(`*.${key}`), `*.${key}`);
    }
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    for (const name of [
      'PLATFORM_ADMIN_ENABLED',
      'ADMIN_ORIGIN',
      'PLATFORM_TOTP_KEYS',
      'PLATFORM_TOTP_ACTIVE_KEY_ID',
      'PLATFORM_SESSION_IDLE_SECONDS',
      'PLATFORM_SESSION_MAX_SECONDS',
    ]) {
      assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), name);
    }
  });
});
