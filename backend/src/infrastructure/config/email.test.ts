import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isLoopbackHost, smtpMailerOptions, smtpRequireTls } from './email.js';
import { parseConfig } from './parse-config.js';
import { REDACT_PATHS } from '../logger/logger.js';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SECRET: 'j'.repeat(32),
};
const ACCOUNTS = {
  ...BASE,
  ACCOUNTS_ENABLED: 'true',
  APP_ORIGIN: 'http://127.0.0.1:5173',
  EMAIL_PROVIDER_HOST: '127.0.0.1',
  EMAIL_PROVIDER_PORT: '1025',
  EMAIL_PROVIDER_FROM: 'noreply@example.test',
};

function failure(env: NodeJS.ProcessEnv): string {
  const result = parseConfig(env);
  if (result.ok) assert.fail('esperava falha de config');
  return result.error.message;
}

describe('config do SMTP (spec 019)', () => {
  it('aceita a configuração do Mailpit sem auth', () => {
    const result = parseConfig(ACCOUNTS);
    assert.ok(result.ok);
    assert.equal(result.value.EMAIL_PROVIDER_PORT, 1025);
    assert.equal(result.value.EMAIL_PROVIDER_SECURE, false);
    assert.equal(smtpMailerOptions(result.value).auth, undefined);
  });

  for (const key of [
    'APP_ORIGIN',
    'EMAIL_PROVIDER_HOST',
    'EMAIL_PROVIDER_PORT',
    'EMAIL_PROVIDER_FROM',
  ]) {
    it(`exige ${key} com ACCOUNTS_ENABLED=true, sem ecoar valores`, () => {
      const env: NodeJS.ProcessEnv = {
        ...ACCOUNTS,
        EMAIL_PROVIDER_USER: '',
        EMAIL_PROVIDER_PSWD: '',
      };
      const env2 = Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
      const message = failure(env2);
      assert.match(message, new RegExp(`${key}: obrigatória`));
      assert.ok(!message.includes('127.0.0.1'));
      // vazio vale como ausente
      assert.equal(parseConfig({ ...env2, [key]: '' }).ok, false);
    });
  }

  it('nada é exigido com ACCOUNTS_ENABLED=false', () => {
    assert.ok(parseConfig({ ...BASE, ACCOUNTS_ENABLED: 'false' }).ok);
    assert.ok(parseConfig(BASE).ok);
  });

  for (const host of [
    'smtp://x',
    'a/b',
    'mail.example.test:25',
    'a b',
    'u@mail.test',
    '[::1]',
    '-x',
  ]) {
    it(`rejeita host inválido ${JSON.stringify(host)}`, () => {
      assert.match(failure({ ...ACCOUNTS, EMAIL_PROVIDER_HOST: host }), /EMAIL_PROVIDER_HOST/);
    });
  }

  for (const host of ['localhost', '127.0.0.1', '::1', 'smtp.gmail.com', 'mail-1.example.test']) {
    it(`aceita host ${host}`, () => {
      assert.ok(parseConfig({ ...ACCOUNTS, EMAIL_PROVIDER_HOST: host }).ok);
    });
  }

  for (const port of ['0', '65536', '25.5', 'abc', '-1']) {
    it(`rejeita porta ${port}`, () => {
      assert.match(failure({ ...ACCOUNTS, EMAIL_PROVIDER_PORT: port }), /EMAIL_PROVIDER_PORT/);
    });
  }

  it('aceita portas 1 e 65535', () => {
    assert.ok(parseConfig({ ...ACCOUNTS, EMAIL_PROVIDER_PORT: '1' }).ok);
    assert.ok(parseConfig({ ...ACCOUNTS, EMAIL_PROVIDER_PORT: '65535' }).ok);
  });

  it('SECURE só aceita true/false literais', () => {
    for (const value of ['1', 'yes', 'TRUE']) {
      assert.match(failure({ ...ACCOUNTS, EMAIL_PROVIDER_SECURE: value }), /EMAIL_PROVIDER_SECURE/);
    }
    const ok = parseConfig({ ...ACCOUNTS, EMAIL_PROVIDER_SECURE: 'true' });
    assert.ok(ok.ok && ok.value.EMAIL_PROVIDER_SECURE);
  });

  for (const from of [
    'nao-e-email',
    'Soprei <a@example.test>',
    'a@example.test\nBcc: x@y.test',
    '<a@example.test>',
  ]) {
    it(`rejeita FROM ${JSON.stringify(from)}`, () => {
      assert.match(failure({ ...ACCOUNTS, EMAIL_PROVIDER_FROM: from }), /EMAIL_PROVIDER_FROM/);
    });
  }

  it('USER e PSWD: tudo ou nada', () => {
    assert.match(failure({ ...ACCOUNTS, EMAIL_PROVIDER_USER: 'u' }), /EMAIL_PROVIDER_USER/);
    assert.match(failure({ ...ACCOUNTS, EMAIL_PROVIDER_PSWD: 'p' }), /EMAIL_PROVIDER_PSWD/);
    assert.ok(parseConfig({ ...ACCOUNTS, EMAIL_PROVIDER_USER: '', EMAIL_PROVIDER_PSWD: '' }).ok);
    const both = parseConfig({ ...ACCOUNTS, EMAIL_PROVIDER_USER: 'u', EMAIL_PROVIDER_PSWD: 'p' });
    assert.ok(both.ok);
    assert.deepEqual(smtpMailerOptions(both.value).auth, { membership: 'u', pass: 'p' });
    assert.ok(!failure({ ...ACCOUNTS, EMAIL_PROVIDER_USER: 'segredo-u' }).includes('segredo-u'));
  });

  it('GMAIL_* são ignoradas', () => {
    const legacy = { ['GMAIL' + '_USER']: 'x', ['GMAIL' + '_APP_PASSWORD']: 'y' };
    assert.ok(parseConfig({ ...ACCOUNTS, ...legacy }).ok);
  });
});

describe('smtpRequireTls', () => {
  it('produção: nunca texto puro, nem em loopback', () => {
    assert.equal(smtpRequireTls('production', false, '127.0.0.1'), true);
    assert.equal(smtpRequireTls('production', false, 'mail.example.test'), true);
    assert.equal(smtpRequireTls('production', true, 'mail.example.test'), false);
  });

  it('fora de produção: texto puro oportunista só em loopback', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) {
      assert.equal(smtpRequireTls('development', false, host), false, host);
      assert.equal(smtpRequireTls('test', false, host), false, host);
    }
    assert.equal(smtpRequireTls('development', false, 'mail.example.test'), true);
    assert.equal(smtpRequireTls('development', false, '10.0.0.5'), true);
    assert.equal(smtpRequireTls('development', false, '128.0.0.1'), true);
    assert.equal(smtpRequireTls('development', true, 'mail.example.test'), false);
  });

  it('loopback não é inferido de nome DNS arbitrário', () => {
    assert.equal(isLoopbackHost('localhost.example.test'), false);
    assert.equal(isLoopbackHost('127.0.0.1.example.test'), false);
  });
});

describe('redact e referências antigas', () => {
  it('redact cobre EMAIL_PROVIDER_USER/PSWD e não mais GMAIL_*', () => {
    assert.ok(REDACT_PATHS.includes('EMAIL_PROVIDER_USER'));
    assert.ok(REDACT_PATHS.includes('EMAIL_PROVIDER_PSWD'));
    assert.ok(!REDACT_PATHS.some((path) => path.includes('GMA' + 'IL')));
  });

  it('nenhuma referência a GMAIL_* ou o mailer antigo do Gmail em backend/src', () => {
    const root = join(import.meta.dirname, '..', '..');
    const pattern = new RegExp(
      ['GMAIL' + '_USER', 'GMAIL' + '_APP_PASSWORD', 'Gmail' + 'VerificationMailer'].join('|'),
    );
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'generated') walk(path);
        } else if (path.endsWith('.ts') && pattern.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});
