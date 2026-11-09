import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from './parse-config.js';

const JWT_SECRET = 'j'.repeat(32);

const VALID_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SECRET,
};

const ACCOUNTS_ON = {
  ACCOUNTS_ENABLED: 'true',
  APP_ORIGIN: 'http://127.0.0.1:5173',
  EMAIL_PROVIDER_HOST: '127.0.0.1',
  EMAIL_PROVIDER_PORT: '1025',
  EMAIL_PROVIDER_FROM: 'noreply@example.test',
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
    const result = parseConfig({ REDIS_URL: VALID_ENV.REDIS_URL, JWT_SECRET });
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

  describe('provedor Anthropic (spec 014)', () => {
    const KEY = 'chave-de-teste-com-mais-de-20-caracteres';
    const ANTHROPIC = { ...VALID_ENV, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY };

    it('defaults: modelo claude-haiku-5-5, esforço low, 1024 tokens, 1 repetição, sem chave e sem base', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      assert.equal(result.value.LLM_MODEL, 'claude-haiku-5-5');
      assert.equal(result.value.LLM_EFFORT, 'low');
      assert.equal(result.value.LLM_MAX_OUTPUT_TOKENS, 1024);
      assert.equal(result.value.LLM_MAX_RETRIES, 1);
      assert.equal(result.value.ANTHROPIC_API_KEY, undefined);
      assert.equal(result.value.ANTHROPIC_BASE_URL, undefined);
    });

    it('mock não exige chave; anthropic sem chave (ausente ou vazia) falha citando a variável, sem valor', () => {
      assert.ok(parseConfig({ ...VALID_ENV, LLM_PROVIDER: 'mock' }).ok);
      for (const key of [undefined, '']) {
        const result = parseConfig({
          ...VALID_ENV,
          LLM_PROVIDER: 'anthropic',
          ...(key === undefined ? {} : { ANTHROPIC_API_KEY: key }),
        });
        assert.equal(result.ok, false);
        assert.match(result.error.message, /ANTHROPIC_API_KEY/);
      }
    });

    it('chave curta é recusada e a mensagem nunca traz o valor', () => {
      const short = 'curta-demais-123';
      const result = parseConfig({ ...ANTHROPIC, ANTHROPIC_API_KEY: short });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /ANTHROPIC_API_KEY/);
      assert.ok(!result.error.message.includes(short));
    });

    it('aceita anthropic com chave válida e os valores customizados', () => {
      const result = parseConfig({
        ...ANTHROPIC,
        LLM_MODEL: 'claude-haiku-5-5',
        LLM_EFFORT: 'high',
        LLM_MAX_OUTPUT_TOKENS: '2048',
        LLM_MAX_RETRIES: '3',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010',
      });
      assert.ok(result.ok);
      assert.equal(result.value.LLM_EFFORT, 'high');
      assert.equal(result.value.LLM_MAX_OUTPUT_TOKENS, 2048);
      assert.equal(result.value.LLM_MAX_RETRIES, 3);
      assert.equal(result.value.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4010');
    });

    const invalid: readonly (readonly [string, string])[] = [
      ['LLM_EFFORT', 'max'],
      ['LLM_EFFORT', 'xhigh'],
      ['LLM_MAX_OUTPUT_TOKENS', '63'],
      ['LLM_MAX_OUTPUT_TOKENS', '8193'],
      ['LLM_MAX_OUTPUT_TOKENS', 'muito'],
      ['LLM_MAX_RETRIES', '-1'],
      ['LLM_MAX_RETRIES', '4'],
      ['LLM_MODEL', 'Claude Haiku'],
      ['LLM_MODEL', 'a/b'],
      ['LLM_MODEL', 'x'.repeat(65)],
      ['ANTHROPIC_BASE_URL', 'nao-e-url'],
      ['ANTHROPIC_BASE_URL', 'ftp://host'],
      ['ANTHROPIC_BASE_URL', 'https://u:p@host'],
    ];
    for (const [name, value] of invalid) {
      it(`rejeita ${name}=${value}`, () => {
        const result = parseConfig({ ...ANTHROPIC, [name]: value });
        assert.equal(result.ok, false);
        assert.match(result.error.message, new RegExp(name));
      });
    }

    it('ANTHROPIC_BASE_URL com http:// é recusada em produção e aceita fora dela', () => {
      const prod = {
        ...ANTHROPIC,
        NODE_ENV: 'production',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010',
      };
      const refused = parseConfig(prod);
      assert.equal(refused.ok, false);
      assert.match(refused.error.message, /ANTHROPIC_BASE_URL/);
      assert.ok(parseConfig({ ...prod, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }).ok);
      assert.ok(parseConfig({ ...prod, NODE_ENV: 'development' }).ok);
    });

    it('os valores dos .env*.example são válidos', () => {
      assert.ok(
        parseConfig({
          ...ANTHROPIC,
          LLM_MODEL: 'claude-haiku-5-5',
          LLM_EFFORT: 'low',
          LLM_MAX_OUTPUT_TOKENS: '1024',
          LLM_MAX_RETRIES: '1',
          ANTHROPIC_BASE_URL: '',
        }).ok,
      );
    });
  });

  describe('atendimento (LLM_PROVIDER, LLM_TIMEOUT_MS, ATTENDANCE_IN_FLIGHT_TIMEOUT_MS)', () => {
    it('aplica os defaults: provedor mock, 15 s de timeout do LLM e 60 s de "em andamento"', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      assert.equal(result.value.LLM_PROVIDER, 'mock');
      assert.equal(result.value.LLM_TIMEOUT_MS, 15_000);
      assert.equal(result.value.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS, 60_000);
    });

    it('converte strings para número', () => {
      const result = parseConfig({
        ...VALID_ENV,
        LLM_PROVIDER: 'mock',
        LLM_TIMEOUT_MS: '2500',
        ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '9000',
      });
      assert.ok(result.ok);
      assert.equal(result.value.LLM_TIMEOUT_MS, 2500);
      assert.equal(result.value.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS, 9000);
    });

    it('os valores dos .env*.example (15000 e 60000) são válidos', () => {
      const result = parseConfig({
        ...VALID_ENV,
        LLM_PROVIDER: 'mock',
        LLM_TIMEOUT_MS: '15000',
        ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '60000',
      });
      assert.ok(result.ok);
    });

    it('ATTENDANCE_IN_FLIGHT_TIMEOUT_MS precisa ser maior que LLM_TIMEOUT_MS', () => {
      for (const [llm, inFlight] of [
        ['15000', '15000'],
        ['15000', '14999'],
        ['120000', '60000'],
        ['5000', '1'],
      ] as const) {
        const result = parseConfig({
          ...VALID_ENV,
          LLM_TIMEOUT_MS: llm,
          ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: inFlight,
        });
        assert.equal(result.ok, false, `${llm}/${inFlight}`);
        assert.match(
          result.error.message,
          /ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: precisa ser maior que LLM_TIMEOUT_MS/,
        );
      }
      // Um milissegundo a mais basta.
      assert.ok(
        parseConfig({
          ...VALID_ENV,
          LLM_TIMEOUT_MS: '15000',
          ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '15001',
        }).ok,
      );
      // Mudar só o LLM_TIMEOUT_MS para além do padrão de 60000 também é pego.
      assert.equal(parseConfig({ ...VALID_ENV, LLM_TIMEOUT_MS: '60000' }).ok, false);
    });

    it('SCHEDULE_AI_ENABLED vem desligada por padrão e só aceita true/false literais', () => {
      const off = parseConfig(VALID_ENV);
      assert.ok(off.ok);
      assert.equal(off.value.SCHEDULE_AI_ENABLED, false);
      const on = parseConfig({ ...VALID_ENV, SCHEDULE_AI_ENABLED: 'true' });
      assert.ok(on.ok);
      assert.equal(on.value.SCHEDULE_AI_ENABLED, true);
      for (const value of ['1', 'yes', 'TRUE', 'sim']) {
        assert.equal(parseConfig({ ...VALID_ENV, SCHEDULE_AI_ENABLED: value }).ok, false, value);
      }
    });

    it('planos e assinaturas (spec 031): tudo desligado por padrão, literais true/false e valores padrão', () => {
      const off = parseConfig(VALID_ENV);
      assert.ok(off.ok);
      assert.equal(off.value.BILLING_ENABLED, false);
      assert.equal(off.value.SOPREI_PAYS_META_ENABLED, false);
      assert.equal(off.value.BILLING_GRACE_DAYS, 5);
      assert.equal(off.value.BILLING_TRIAL_DAYS, 7);
      assert.equal(off.value.BILLING_TRIAL_TOKENS, 300_000);
      const on = parseConfig({ ...VALID_ENV, ...ACCOUNTS_ON, BILLING_ENABLED: 'true' });
      assert.ok(on.ok);
      assert.equal(on.value.BILLING_ENABLED, true);
      for (const value of ['1', 'yes', 'TRUE']) {
        assert.equal(parseConfig({ ...VALID_ENV, BILLING_ENABLED: value }).ok, false, value);
        assert.equal(
          parseConfig({ ...VALID_ENV, SOPREI_PAYS_META_ENABLED: value }).ok,
          false,
          value,
        );
      }
      assert.equal(parseConfig({ ...VALID_ENV, BILLING_TRIAL_DAYS: '0' }).ok, false);
      assert.equal(parseConfig({ ...VALID_ENV, BILLING_GRACE_DAYS: '-1' }).ok, false);
    });

    it('BILLING_ENABLED exige ACCOUNTS_ENABLED=true (a cobrança vive na sessão da conta)', () => {
      const alone = parseConfig({ ...VALID_ENV, BILLING_ENABLED: 'true' });
      assert.equal(alone.ok, false);
      assert.match(alone.error.message, /BILLING_ENABLED: exige ACCOUNTS_ENABLED=true/);
      assert.ok(parseConfig({ ...VALID_ENV, ...ACCOUNTS_ON, BILLING_ENABLED: 'true' }).ok);
    });

    it('gate do modo S (spec 031): SOPREI_PAYS_META_ENABLED exige BILLING_ENABLED=true', () => {
      const alone = parseConfig({ ...VALID_ENV, SOPREI_PAYS_META_ENABLED: 'true' });
      assert.equal(alone.ok, false);
      assert.match(alone.error.message, /SOPREI_PAYS_META_ENABLED: exige BILLING_ENABLED=true/);
      const both = parseConfig({
        ...VALID_ENV,
        ...ACCOUNTS_ON,
        BILLING_ENABLED: 'true',
        SOPREI_PAYS_META_ENABLED: 'true',
      });
      assert.ok(both.ok);
      assert.equal(both.value.SOPREI_PAYS_META_ENABLED, true);
    });

    it('checkout da InfinitePay (spec 031, E3): desligado por padrão, nada INFINITEPAY_* é exigido e a base padrão é a da API', () => {
      const off = parseConfig({ ...VALID_ENV, ...ACCOUNTS_ON, BILLING_ENABLED: 'true' });
      assert.ok(off.ok);
      assert.equal(off.value.CHECKOUT_ENABLED, false);
      assert.equal(off.value.INFINITEPAY_API_BASE_URL, 'https://api.checkout.infinitepay.io');
      assert.equal(off.value.INFINITEPAY_API_KEY, undefined);
      assert.equal(off.value.BILLING_HTTP_TIMEOUT_MS, 8_000);
      for (const value of ['1', 'yes', 'TRUE']) {
        assert.equal(parseConfig({ ...VALID_ENV, CHECKOUT_ENABLED: value }).ok, false, value);
      }
    });

    describe('com CHECKOUT_ENABLED=true', () => {
      const CHECKOUT_ON = {
        ...VALID_ENV,
        ...ACCOUNTS_ON,
        BILLING_ENABLED: 'true',
        CHECKOUT_ENABLED: 'true',
        INFINITEPAY_API_KEY: 'inchk_chave_de_teste_0123',
        INFINITEPAY_HANDLE: 'loja-teste',
        INFINITEPAY_WEBHOOK_BASE_URL: 'https://api.exemplo.test',
      };

      it('aceita a configuração completa', () => {
        const result = parseConfig(CHECKOUT_ON);
        assert.ok(result.ok);
        assert.equal(result.value.INFINITEPAY_HANDLE, 'loja-teste');
      });

      it('exige BILLING_ENABLED e as três variáveis', () => {
        const noBilling = parseConfig({ ...CHECKOUT_ON, BILLING_ENABLED: 'false' });
        assert.equal(noBilling.ok, false);
        assert.match(noBilling.error.message, /CHECKOUT_ENABLED: exige BILLING_ENABLED=true/);
        for (const name of [
          'INFINITEPAY_API_KEY',
          'INFINITEPAY_HANDLE',
          'INFINITEPAY_WEBHOOK_BASE_URL',
        ]) {
          const result = parseConfig({ ...CHECKOUT_ON, [name]: '' });
          assert.equal(result.ok, false, name);
          assert.match(
            result.error.message,
            new RegExp(name + ': obrigatória com CHECKOUT_ENABLED=true'),
          );
        }
      });

      it('valida a chave curta, o handle (sem cifrão) e a origem do webhook (sem caminho nem barra final)', () => {
        assert.equal(parseConfig({ ...CHECKOUT_ON, INFINITEPAY_API_KEY: 'curta' }).ok, false);
        assert.equal(parseConfig({ ...CHECKOUT_ON, INFINITEPAY_HANDLE: '$loja' }).ok, false);
        for (const url of [
          'https://api.exemplo.test/',
          'https://api.exemplo.test/webhooks',
          'ftp://api.exemplo.test',
          'https://u:p@api.exemplo.test',
          'não é url',
        ]) {
          assert.equal(
            parseConfig({ ...CHECKOUT_ON, INFINITEPAY_WEBHOOK_BASE_URL: url }).ok,
            false,
            url,
          );
        }
        assert.ok(
          parseConfig({ ...CHECKOUT_ON, INFINITEPAY_WEBHOOK_BASE_URL: 'http://localhost:3000' }).ok,
        );
      });

      it('em produção as duas bases precisam ser https; fora dela http é aceito (servidor falso)', () => {
        const production = { ...CHECKOUT_ON, NODE_ENV: 'production', TRUST_PROXY: 'false' };
        const webhookHttp = parseConfig({
          ...production,
          INFINITEPAY_WEBHOOK_BASE_URL: 'http://api.exemplo.test',
        });
        assert.equal(webhookHttp.ok, false);
        assert.match(webhookHttp.error.message, /INFINITEPAY_WEBHOOK_BASE_URL: precisa ser https/);
        const apiHttp = parseConfig({
          ...production,
          INFINITEPAY_API_BASE_URL: 'http://127.0.0.1:9999',
        });
        assert.equal(apiHttp.ok, false);
        assert.match(apiHttp.error.message, /INFINITEPAY_API_BASE_URL: precisa ser https/);
        assert.ok(
          parseConfig({ ...CHECKOUT_ON, INFINITEPAY_API_BASE_URL: 'http://127.0.0.1:9999' }).ok,
        );
      });
    });

    it('com SCHEDULE_AI_ENABLED, "em andamento" precisa passar do prazo de 30 s do laço', () => {
      const result = parseConfig({
        ...VALID_ENV,
        SCHEDULE_AI_ENABLED: 'true',
        ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '30000',
        LLM_TIMEOUT_MS: '10000',
      });
      assert.equal(result.ok, false);
      assert.match(
        result.error.message,
        /ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: precisa ser maior que o prazo do turno/,
      );
      assert.ok(
        parseConfig({
          ...VALID_ENV,
          SCHEDULE_AI_ENABLED: 'true',
          ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '30001',
          LLM_TIMEOUT_MS: '10000',
        }).ok,
      );
      // Desligada, o prazo curto continua valendo como antes.
      assert.ok(
        parseConfig({
          ...VALID_ENV,
          ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '30000',
          LLM_TIMEOUT_MS: '10000',
        }).ok,
      );
    });

    const invalid: readonly (readonly [string, string])[] = [
      ['LLM_PROVIDER', 'openai'],
      ['LLM_PROVIDER', ''],
      ['LLM_TIMEOUT_MS', '0'],
      ['LLM_TIMEOUT_MS', '120001'],
      ['LLM_TIMEOUT_MS', 'rapido'],
      ['ATTENDANCE_IN_FLIGHT_TIMEOUT_MS', '0'],
      ['ATTENDANCE_IN_FLIGHT_TIMEOUT_MS', '3600001'],
    ];
    for (const [name, value] of invalid) {
      it(`rejeita ${name}=${value === '' ? '(vazio)' : value}`, () => {
        const result = parseConfig({ ...VALID_ENV, [name]: value });
        assert.equal(result.ok, false);
        assert.match(result.error.message, new RegExp(name));
      });
    }
  });

  describe('autenticação (spec 007)', () => {
    it('JWT_SECRET é obrigatória em todos os ambientes', () => {
      for (const NODE_ENV of ['development', 'test', 'production']) {
        const result = parseConfig({
          DATABASE_URL: VALID_ENV.DATABASE_URL,
          REDIS_URL: VALID_ENV.REDIS_URL,
          NODE_ENV,
        });
        assert.equal(result.ok, false, NODE_ENV);
        assert.match(result.error.message, /JWT_SECRET: variável obrigatória ausente/);
      }
    });

    it('JWT_SECRET com menos de 32 caracteres falha, sem ecoar o valor', () => {
      const value = 'curto-demais-0123456789-abcdef';
      assert.ok(value.length < 32);
      for (const candidate of [value, '', 'a'.repeat(31)]) {
        const result = parseConfig({ ...VALID_ENV, JWT_SECRET: candidate });
        assert.equal(result.ok, false, candidate);
        assert.match(result.error.message, /JWT_SECRET/);
        assert.ok(!result.error.message.includes(value));
      }
      assert.ok(parseConfig({ ...VALID_ENV, JWT_SECRET: 'a'.repeat(32) }).ok);
    });

    it('aplica os defaults dos prazos, do bloqueio e dos perfis de login e refresh', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      const config = result.value;
      assert.equal(config.JWT_ISSUER, 'soprei');
      assert.equal(config.JWT_AUDIENCE, 'soprei-api');
      assert.equal(config.AUTH_ACCESS_TTL_SECONDS, 900);
      assert.equal(config.AUTH_REFRESH_TTL_SECONDS, 604_800);
      assert.equal(config.AUTH_SESSION_MAX_SECONDS, 2_592_000);
      assert.equal(config.AUTH_CLOCK_TOLERANCE_SECONDS, 5);
      assert.equal(config.AUTH_LOGIN_MAX_FAILURES, 5);
      assert.equal(config.AUTH_LOGIN_LOCK_SECONDS, 900);
      assert.equal(config.AUTH_REDIS_TIMEOUT_MS, 500);
      assert.equal(config.AUTH_REDIS_PREFIX, 'soprei:auth:');
      assert.equal(config.RATE_LIMIT_LOGIN_MAX, 10);
      assert.equal(config.RATE_LIMIT_LOGIN_WINDOW_SECONDS, 900);
      assert.equal(config.RATE_LIMIT_REFRESH_MAX, 60);
      assert.equal(config.RATE_LIMIT_REFRESH_WINDOW_SECONDS, 900);
    });

    const outOfRange: readonly (readonly [string, string])[] = [
      ['AUTH_ACCESS_TTL_SECONDS', '59'],
      ['AUTH_ACCESS_TTL_SECONDS', '3601'],
      ['AUTH_REFRESH_TTL_SECONDS', '3599'],
      ['AUTH_REFRESH_TTL_SECONDS', '2592001'],
      ['AUTH_CLOCK_TOLERANCE_SECONDS', '-1'],
      ['AUTH_CLOCK_TOLERANCE_SECONDS', '61'],
      ['AUTH_LOGIN_MAX_FAILURES', '0'],
      ['AUTH_LOGIN_MAX_FAILURES', '21'],
      ['AUTH_LOGIN_LOCK_SECONDS', '59'],
      ['AUTH_LOGIN_LOCK_SECONDS', '86401'],
      ['AUTH_REDIS_TIMEOUT_MS', '0'],
      ['AUTH_REDIS_TIMEOUT_MS', '10001'],
      ['AUTH_REDIS_PREFIX', 'com espaço'],
      ['RATE_LIMIT_LOGIN_MAX', '0'],
      ['RATE_LIMIT_REFRESH_WINDOW_SECONDS', '86401'],
    ];
    for (const [name, value] of outOfRange) {
      it(`rejeita ${name}=${value}`, () => {
        const result = parseConfig({ ...VALID_ENV, [name]: value });
        assert.equal(result.ok, false);
        assert.match(result.error.message, new RegExp(name));
      });
    }

    it('AUTH_SESSION_MAX_SECONDS menor que AUTH_REFRESH_TTL_SECONDS falha (regra cruzada)', () => {
      const result = parseConfig({
        ...VALID_ENV,
        AUTH_REFRESH_TTL_SECONDS: '86400',
        AUTH_SESSION_MAX_SECONDS: '3600',
      });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /AUTH_SESSION_MAX_SECONDS/);
      assert.ok(
        parseConfig({
          ...VALID_ENV,
          AUTH_REFRESH_TTL_SECONDS: '86400',
          AUTH_SESSION_MAX_SECONDS: '86400',
        }).ok,
      );
    });

    it('ADMIN_API_KEY foi removida: no ambiente é ignorada (não quebra o boot) e não vira config', () => {
      for (const value of ['', 'curta', 'a'.repeat(40)]) {
        for (const NODE_ENV of ['development', 'production']) {
          const result = parseConfig({ ...VALID_ENV, NODE_ENV, ADMIN_API_KEY: value });
          assert.ok(result.ok, `${NODE_ENV} / ${value}`);
          assert.ok(!('ADMIN_API_KEY' in result.value));
        }
      }
    });
  });

  describe('METRICS_TOKEN', () => {
    const TOKEN = 'm'.repeat(32);

    it('é opcional em qualquer ambiente; ausente ou vazio vale como ausente', () => {
      for (const NODE_ENV of ['development', 'test']) {
        const result = parseConfig({ ...VALID_ENV, NODE_ENV });
        assert.ok(result.ok, NODE_ENV);
        assert.equal(result.value.METRICS_TOKEN, undefined);
      }
      const empty = parseConfig({ ...VALID_ENV, METRICS_TOKEN: '' });
      assert.ok(empty.ok);
      assert.equal(empty.value.METRICS_TOKEN, undefined);
    });

    it('rejeita token com menos de 32 caracteres, sem ecoar o valor', () => {
      const value = 'curto-demais-segredo';
      const result = parseConfig({ ...VALID_ENV, METRICS_TOKEN: value });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /METRICS_TOKEN: se informado, precisa ter no mínimo 32/);
      assert.ok(!result.error.message.includes(value));
      const edge = parseConfig({ ...VALID_ENV, METRICS_TOKEN: 'a'.repeat(31) });
      assert.equal(edge.ok, false);
    });

    it('aceita 32 caracteres ou mais', () => {
      for (const value of [TOKEN, TOKEN + 'x']) {
        const result = parseConfig({ ...VALID_ENV, METRICS_TOKEN: value });
        assert.ok(result.ok);
        assert.equal(result.value.METRICS_TOKEN, value);
      }
    });

    it('a regra vale também em produção', () => {
      const result = parseConfig({
        ...VALID_ENV,
        NODE_ENV: 'production',
        METRICS_TOKEN: 'curto',
      });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /METRICS_TOKEN/);
    });
  });

  describe('rate limiting (spec 005)', () => {
    const PRODUCTION = {
      ...VALID_ENV,
      NODE_ENV: 'production',
    };

    it('aplica os defaults: ligado, 100/15 min público, 600/min admin e webhook, 250 ms, sem proxy', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      const config = result.value;
      assert.equal(config.RATE_LIMIT_ENABLED, true);
      assert.equal(config.RATE_LIMIT_PUBLIC_MAX, 100);
      assert.equal(config.RATE_LIMIT_PUBLIC_WINDOW_SECONDS, 900);
      assert.equal(config.RATE_LIMIT_ADMIN_MAX, 600);
      assert.equal(config.RATE_LIMIT_ADMIN_WINDOW_SECONDS, 60);
      assert.equal(config.RATE_LIMIT_WEBHOOK_MAX, 600);
      assert.equal(config.RATE_LIMIT_WEBHOOK_WINDOW_SECONDS, 60);
      assert.equal(config.RATE_LIMIT_REDIS_TIMEOUT_MS, 250);
      assert.equal(config.TRUST_PROXY, false);
    });

    it('converte os valores informados para número', () => {
      const result = parseConfig({
        ...VALID_ENV,
        RATE_LIMIT_ADMIN_MAX: '5',
        RATE_LIMIT_ADMIN_WINDOW_SECONDS: '86400',
        RATE_LIMIT_REDIS_TIMEOUT_MS: '50',
      });
      assert.ok(result.ok);
      assert.equal(result.value.RATE_LIMIT_ADMIN_MAX, 5);
      assert.equal(result.value.RATE_LIMIT_ADMIN_WINDOW_SECONDS, 86_400);
      assert.equal(result.value.RATE_LIMIT_REDIS_TIMEOUT_MS, 50);
    });

    const profiles = ['PUBLIC', 'ADMIN', 'WEBHOOK'];
    for (const profile of profiles) {
      for (const invalid of ['0', '-1', 'abc', '1.5']) {
        it(`rejeita RATE_LIMIT_${profile}_MAX=${invalid}`, () => {
          const name = `RATE_LIMIT_${profile}_MAX`;
          const result = parseConfig({ ...VALID_ENV, [name]: invalid });
          assert.equal(result.ok, false);
          assert.match(result.error.message, new RegExp(name));
        });
      }
      for (const invalid of ['0', '-1', 'abc', '86401']) {
        it(`rejeita RATE_LIMIT_${profile}_WINDOW_SECONDS=${invalid}`, () => {
          const name = `RATE_LIMIT_${profile}_WINDOW_SECONDS`;
          const result = parseConfig({ ...VALID_ENV, [name]: invalid });
          assert.equal(result.ok, false);
          assert.match(result.error.message, new RegExp(name));
        });
      }
    }

    it('rejeita RATE_LIMIT_REDIS_TIMEOUT_MS inválido', () => {
      for (const invalid of ['0', '-5', 'x', '10001']) {
        const result = parseConfig({ ...VALID_ENV, RATE_LIMIT_REDIS_TIMEOUT_MS: invalid });
        assert.equal(result.ok, false, invalid);
        assert.match(result.error.message, /RATE_LIMIT_REDIS_TIMEOUT_MS/);
      }
    });

    it('RATE_LIMIT_ENABLED: "false" literal desliga (não vira verdadeiro) fora de produção', () => {
      const off = parseConfig({ ...VALID_ENV, RATE_LIMIT_ENABLED: 'false' });
      assert.ok(off.ok);
      assert.equal(off.value.RATE_LIMIT_ENABLED, false);
      const on = parseConfig({ ...VALID_ENV, RATE_LIMIT_ENABLED: 'true' });
      assert.ok(on.ok);
      assert.equal(on.value.RATE_LIMIT_ENABLED, true);
      const empty = parseConfig({ ...VALID_ENV, RATE_LIMIT_ENABLED: '' });
      assert.ok(empty.ok);
      assert.equal(empty.value.RATE_LIMIT_ENABLED, true);
    });

    it('RATE_LIMIT_ENABLED rejeita qualquer outro texto', () => {
      for (const invalid of ['0', '1', 'no', 'FALSE', 'off']) {
        const result = parseConfig({ ...VALID_ENV, RATE_LIMIT_ENABLED: invalid });
        assert.equal(result.ok, false, invalid);
        assert.match(result.error.message, /RATE_LIMIT_ENABLED/);
      }
    });

    it('RATE_LIMIT_ENABLED=false é rejeitado em produção; ligado ou ausente passa', () => {
      const off = parseConfig({ ...PRODUCTION, RATE_LIMIT_ENABLED: 'false' });
      assert.equal(off.ok, false);
      assert.match(off.error.message, /RATE_LIMIT_ENABLED: não pode ser "false" em produção/);
      assert.ok(parseConfig({ ...PRODUCTION, RATE_LIMIT_ENABLED: 'true' }).ok);
      assert.ok(parseConfig(PRODUCTION).ok);
    });

    it('TRUST_PROXY=true é rejeitado em produção; false e lista passam', () => {
      const bad = parseConfig({ ...PRODUCTION, TRUST_PROXY: 'true' });
      assert.equal(bad.ok, false);
      assert.match(bad.error.message, /TRUST_PROXY: não pode ser "true" em produção/);
      assert.ok(parseConfig({ ...PRODUCTION, TRUST_PROXY: 'false' }).ok);
      assert.ok(parseConfig({ ...PRODUCTION, TRUST_PROXY: '127.0.0.1,::1' }).ok);
      // Fora de produção segue aceito (ambiente fechado), com warn no boot.
      assert.ok(parseConfig({ ...VALID_ENV, NODE_ENV: 'development', TRUST_PROXY: 'true' }).ok);
      assert.ok(parseConfig({ ...VALID_ENV, NODE_ENV: 'test', TRUST_PROXY: 'true' }).ok);
    });

    it('TRUST_PROXY aceita false, true e lista de IPs/CIDRs e rejeita inteiro e lixo', () => {
      const trust = (value: string): unknown => {
        const result = parseConfig({ ...VALID_ENV, TRUST_PROXY: value });
        assert.ok(result.ok, value);
        return result.value.TRUST_PROXY;
      };
      assert.equal(trust('false'), false);
      assert.equal(trust('true'), true);
      assert.deepEqual(trust('127.0.0.1,::1'), ['127.0.0.1', '::1']);
      assert.deepEqual(trust('10.0.0.0/8,172.16.0.1'), ['10.0.0.0/8', '172.16.0.1']);

      const bad = parseConfig({ ...VALID_ENV, TRUST_PROXY: 'talvez' });
      assert.equal(bad.ok, false);
      assert.match(bad.error.message, /TRUST_PROXY/);
      for (const integer of ['0', '1', '2']) {
        assert.equal(parseConfig({ ...VALID_ENV, TRUST_PROXY: integer }).ok, false, integer);
      }
    });
  });

  describe('canal WhatsApp (spec 011)', () => {
    const SECRETS = {
      WHATSAPP_APP_SECRET: 'segredo-do-app-meta',
      WHATSAPP_VERIFY_TOKEN: 'token-de-verificacao-16+',
      WHATSAPP_APP_ID: '123456789012345',
      CHANNEL_CREDENTIALS_KEYS: `k1:${'A'.repeat(43)}`,
      CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: 'k1',
    };
    const PRODUCTION = { ...VALID_ENV, NODE_ENV: 'production' };
    const ENABLED = { ...VALID_ENV, ...SECRETS, WHATSAPP_ENABLED: 'true', TRUST_PROXY: 'false' };

    it('por padrão o canal está desligado e as variáveis têm defaults', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      assert.equal(result.value.WHATSAPP_ENABLED, false);
      assert.equal(result.value.WHATSAPP_API_BASE_URL, 'https://graph.facebook.com');
      assert.match(result.value.WHATSAPP_GRAPH_API_VERSION, /^v\d+\.\d+$/);
      assert.equal(result.value.WHATSAPP_SEND_TIMEOUT_MS, 10_000);
      assert.equal(result.value.QUEUE_ATTEMPTS, 5);
      assert.equal(result.value.QUEUE_BACKOFF_MS, 10_000);
      assert.equal(result.value.QUEUE_KEEP_COMPLETED_SECONDS, 3_600);
      assert.equal(result.value.QUEUE_KEEP_FAILED_SECONDS, 86_400);
    });

    it('WHATSAPP_ENABLED=false literal não habilita; só "true" e "false" são aceitos', () => {
      const off = parseConfig({ ...VALID_ENV, WHATSAPP_ENABLED: 'false' });
      assert.ok(off.ok);
      assert.equal(off.value.WHATSAPP_ENABLED, false);
      assert.equal(parseConfig({ ...VALID_ENV, WHATSAPP_ENABLED: '' }).ok, true);
      for (const invalid of ['0', '1', 'yes', 'FALSE', 'on']) {
        const result = parseConfig({ ...VALID_ENV, WHATSAPP_ENABLED: invalid });
        assert.equal(result.ok, false, invalid);
        assert.match(result.error.message, /WHATSAPP_ENABLED/);
      }
    });

    it('WHATSAPP_ACCESS_TOKEN é opcional (só empresas LEGACY); se informado, mínimo 16', () => {
      assert.ok(parseConfig(ENABLED).ok);
      assert.ok(parseConfig({ ...ENABLED, WHATSAPP_ACCESS_TOKEN: 'x'.repeat(16) }).ok);
      assert.equal(parseConfig({ ...ENABLED, WHATSAPP_ACCESS_TOKEN: 'curto' }).ok, false);
    });

    it('chaves de cifra: tamanho, keyId repetido, ativo fora da lista e APP_ID inválido falham sem ecoar a chave', () => {
      const secretKey = 'B'.repeat(43);
      const cases: Record<string, Record<string, string>> = {
        CHANNEL_CREDENTIALS_KEYS: { CHANNEL_CREDENTIALS_KEYS: `k1:${'C'.repeat(20)}` },
        repetido: { CHANNEL_CREDENTIALS_KEYS: `k1:${secretKey},k1:${secretKey}` },
        CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: { CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: 'k9' },
        WHATSAPP_APP_ID: { WHATSAPP_APP_ID: 'abc' },
      };
      for (const [label, override] of Object.entries(cases)) {
        const result = parseConfig({ ...ENABLED, ...override });
        assert.equal(result.ok, false, label);
        assert.ok(!result.error.message.includes(secretKey), label);
        assert.ok(!result.error.message.includes('C'.repeat(20)), label);
      }
      // Desligado, nada disso é exigido.
      assert.ok(parseConfig({ ...VALID_ENV, WHATSAPP_ENABLED: 'false' }).ok);
    });

    it('habilitado com os três segredos e TRUST_PROXY explícito passa', () => {
      const result = parseConfig(ENABLED);
      assert.ok(result.ok);
      assert.equal(result.value.WHATSAPP_ENABLED, true);
    });

    it('habilitado sem cada um dos três segredos (ou com ele vazio) falha citando a variável', () => {
      for (const name of Object.keys(SECRETS)) {
        const absent = parseConfig({ ...ENABLED, [name]: undefined });
        assert.equal(absent.ok, false, name);
        assert.match(absent.error.message, new RegExp(`${name}: obrigatória`));
        const blank = parseConfig({ ...ENABLED, [name]: '' });
        assert.equal(blank.ok, false, `${name} vazio`);
      }
    });

    it('os segredos só são exigidos com o canal habilitado', () => {
      assert.ok(parseConfig({ ...VALID_ENV, WHATSAPP_ENABLED: 'false' }).ok);
      assert.ok(parseConfig(VALID_ENV).ok);
    });

    it('WHATSAPP_VERIFY_TOKEN exige no mínimo 16 caracteres', () => {
      const short = parseConfig({ ...ENABLED, WHATSAPP_VERIFY_TOKEN: 'x'.repeat(15) });
      assert.equal(short.ok, false);
      assert.match(short.error.message, /WHATSAPP_VERIFY_TOKEN: precisa ter no mínimo 16/);
      assert.ok(parseConfig({ ...ENABLED, WHATSAPP_VERIFY_TOKEN: 'x'.repeat(16) }).ok);
    });

    it('WHATSAPP_APP_SECRET e WHATSAPP_ACCESS_TOKEN exigem no mínimo 16 caracteres (e o valor não aparece na mensagem)', () => {
      for (const name of ['WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN']) {
        const short = parseConfig({ ...ENABLED, [name]: 'abcdefghijklmno' });
        assert.equal(short.ok, false, name);
        assert.match(short.error.message, new RegExp(`${name}: precisa ter no mínimo 16`));
        assert.ok(!short.error.message.includes('abcdefghijklmno'));
        assert.ok(parseConfig({ ...ENABLED, [name]: 'x'.repeat(16) }).ok, name);
      }
      // Desligado, os segredos não são exigidos nem medidos.
      assert.ok(parseConfig({ ...VALID_ENV, WHATSAPP_APP_SECRET: 'x' }).ok);
    });

    it('habilitado sem TRUST_PROXY definido explicitamente falha; "false" explícito passa', () => {
      const withoutTrustProxy = Object.fromEntries(
        Object.entries(ENABLED).filter(([name]) => name !== 'TRUST_PROXY'),
      );
      const absent = parseConfig(withoutTrustProxy);
      assert.equal(absent.ok, false);
      assert.match(absent.error.message, /TRUST_PROXY: precisa ser definida explicitamente/);
      assert.equal(parseConfig({ ...withoutTrustProxy, TRUST_PROXY: '' }).ok, false);
      assert.ok(parseConfig({ ...withoutTrustProxy, TRUST_PROXY: 'false' }).ok);
      assert.ok(parseConfig({ ...withoutTrustProxy, TRUST_PROXY: '127.0.0.1,::1' }).ok);
      // Desligado, TRUST_PROXY segue opcional.
      assert.ok(parseConfig(VALID_ENV).ok);
    });

    it('WHATSAPP_GRAPH_API_VERSION exige o formato vNN.N', () => {
      assert.ok(parseConfig({ ...VALID_ENV, WHATSAPP_GRAPH_API_VERSION: 'v24.0' }).ok);
      for (const invalid of ['26.0', 'v26', 'v26.0.1', 'latest', 'v26.0/../x']) {
        const result = parseConfig({ ...VALID_ENV, WHATSAPP_GRAPH_API_VERSION: invalid });
        assert.equal(result.ok, false, invalid);
        assert.match(result.error.message, /WHATSAPP_GRAPH_API_VERSION/);
      }
    });

    it('WHATSAPP_API_BASE_URL: http só fora de produção; sem credencial, query nem fragmento', () => {
      const local = { ...VALID_ENV, WHATSAPP_API_BASE_URL: 'http://127.0.0.1:4010' };
      assert.ok(parseConfig({ ...local, NODE_ENV: 'development' }).ok);
      assert.ok(parseConfig({ ...local, NODE_ENV: 'test' }).ok);
      const production = parseConfig({ ...PRODUCTION, WHATSAPP_API_BASE_URL: 'http://x.test' });
      assert.equal(production.ok, false);
      assert.match(production.error.message, /WHATSAPP_API_BASE_URL: precisa ser https/);
      assert.ok(parseConfig({ ...PRODUCTION, WHATSAPP_API_BASE_URL: 'https://x.test' }).ok);
      for (const invalid of [
        'ftp://x.test',
        'https://u:p@x.test',
        'https://x.test?a=1',
        'https://x.test#f',
        'não é url',
      ]) {
        assert.equal(
          parseConfig({ ...VALID_ENV, WHATSAPP_API_BASE_URL: invalid }).ok,
          false,
          invalid,
        );
      }
    });

    it('valida WHATSAPP_SEND_TIMEOUT_MS e as variáveis da fila', () => {
      for (const [name, value] of [
        ['WHATSAPP_SEND_TIMEOUT_MS', '0'],
        ['QUEUE_ATTEMPTS', '0'],
        ['QUEUE_ATTEMPTS', '21'],
        ['QUEUE_BACKOFF_MS', '0'],
        ['QUEUE_KEEP_COMPLETED_SECONDS', '-1'],
        ['QUEUE_KEEP_FAILED_SECONDS', 'abc'],
      ] as const) {
        const result = parseConfig({ ...VALID_ENV, [name]: value });
        assert.equal(result.ok, false, `${name}=${value}`);
        assert.match(result.error.message, new RegExp(name));
      }
    });

    it('regra cruzada: backoff x (2^(tentativas-1) - 1) precisa passar de ATTENDANCE_IN_FLIGHT_TIMEOUT_MS', () => {
      // Padrões: 10 000 x 15 = 150 000 > 60 000.
      assert.ok(parseConfig(ENABLED).ok);
      // 5 tentativas x 1 000 ms: 15 000 <= 60 000.
      const bad = parseConfig({ ...ENABLED, QUEUE_BACKOFF_MS: '1000' });
      assert.equal(bad.ok, false);
      assert.match(bad.error.message, /QUEUE_BACKOFF_MS x \(2\^\(QUEUE_ATTEMPTS - 1\) - 1\)/);
      // Igual ao limite também falha (precisa ser MAIOR).
      const equal = parseConfig({
        ...ENABLED,
        QUEUE_ATTEMPTS: '3',
        QUEUE_BACKOFF_MS: '20000',
        ATTENDANCE_IN_FLIGHT_TIMEOUT_MS: '60000',
      });
      assert.equal(equal.ok, false);
      // Uma só tentativa não tem retentativa: soma 0, nunca passa.
      assert.equal(parseConfig({ ...ENABLED, QUEUE_ATTEMPTS: '1' }).ok, false);
      // Subir o backoff resolve; com o canal desligado a regra não se aplica.
      assert.ok(parseConfig({ ...ENABLED, QUEUE_BACKOFF_MS: '5000', QUEUE_ATTEMPTS: '6' }).ok);
      assert.ok(parseConfig({ ...VALID_ENV, QUEUE_BACKOFF_MS: '1000' }).ok);
    });
  });

  describe('conectar pelo site (spec 023)', () => {
    const ENABLED = {
      ...VALID_ENV,
      WHATSAPP_APP_SECRET: 'segredo-do-app-meta',
      WHATSAPP_VERIFY_TOKEN: 'token-de-verificacao-16+',
      WHATSAPP_APP_ID: '123456789012345',
      CHANNEL_CREDENTIALS_KEYS: `k1:${'A'.repeat(43)}`,
      CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: 'k1',
      WHATSAPP_ENABLED: 'true',
      TRUST_PROXY: 'false',
    };

    it('os padrões: sem config_id e formulário manual desligado', () => {
      const result = parseConfig(ENABLED);
      assert.ok(result.ok);
      assert.equal(result.value.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, undefined);
      assert.equal(result.value.CHANNEL_MANUAL_CONNECT_ENABLED, false);
      const empty = parseConfig({ ...ENABLED, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '' });
      assert.ok(empty.ok);
      assert.equal(empty.value.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, undefined);
    });

    it('WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: só dígitos (1 a 32) e exige o canal ligado', () => {
      const ok = parseConfig({ ...ENABLED, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '987654321' });
      assert.ok(ok.ok);
      assert.equal(ok.value.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, '987654321');
      for (const invalid of ['abc', '12 3', '1'.repeat(33), '-1']) {
        const result = parseConfig({ ...ENABLED, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: invalid });
        assert.equal(result.ok, false, invalid);
        assert.match(result.error.message, /WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID/);
      }
      const off = parseConfig({ ...VALID_ENV, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '123' });
      assert.equal(off.ok, false);
      assert.match(off.error.message, /WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID/);
    });

    it('CHANNEL_MANUAL_CONNECT_ENABLED: literais true/false; true é recusado em produção', () => {
      const on = parseConfig({ ...ENABLED, CHANNEL_MANUAL_CONNECT_ENABLED: 'true' });
      assert.ok(on.ok);
      assert.equal(on.value.CHANNEL_MANUAL_CONNECT_ENABLED, true);
      for (const invalid of ['1', 'yes', 'TRUE']) {
        assert.equal(
          parseConfig({ ...ENABLED, CHANNEL_MANUAL_CONNECT_ENABLED: invalid }).ok,
          false,
          invalid,
        );
      }
      const production = parseConfig({
        ...ENABLED,
        NODE_ENV: 'production',
        CHANNEL_MANUAL_CONNECT_ENABLED: 'true',
      });
      assert.equal(production.ok, false);
      assert.match(production.error.message, /CHANNEL_MANUAL_CONNECT_ENABLED/);
    });
  });

  describe('agrupamento de mensagens do canal (spec 013)', () => {
    const ENABLED = {
      ...VALID_ENV,
      WHATSAPP_APP_SECRET: 'segredo-do-app-meta',
      WHATSAPP_VERIFY_TOKEN: 'token-de-verificacao-16+',
      WHATSAPP_APP_ID: '123456789012345',
      CHANNEL_CREDENTIALS_KEYS: `k1:${'A'.repeat(43)}`,
      CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: 'k1',
      WHATSAPP_ENABLED: 'true',
      TRUST_PROXY: 'false',
    };

    it('aplica os defaults: janela de 5 s, teto de 20 s, 10 mensagens e 8 000 caracteres', () => {
      const result = parseConfig(VALID_ENV);
      assert.ok(result.ok);
      assert.equal(result.value.CHANNEL_BATCH_WINDOW_MS, 5_000);
      assert.equal(result.value.CHANNEL_BATCH_MAX_WAIT_MS, 20_000);
      assert.equal(result.value.CHANNEL_BATCH_MAX_MESSAGES, 10);
      assert.equal(result.value.CHANNEL_BATCH_MAX_CHARS, 8_000);
      assert.ok(parseConfig(ENABLED).ok);
    });

    it('converte strings para número e aceita os extremos', () => {
      const result = parseConfig({
        ...ENABLED,
        CHANNEL_BATCH_WINDOW_MS: '0',
        CHANNEL_BATCH_MAX_WAIT_MS: '0',
        CHANNEL_BATCH_MAX_MESSAGES: '50',
        CHANNEL_BATCH_MAX_CHARS: '24000',
      });
      assert.ok(result.ok);
      assert.equal(result.value.CHANNEL_BATCH_WINDOW_MS, 0);
      assert.equal(result.value.CHANNEL_BATCH_MAX_MESSAGES, 50);
      assert.equal(result.value.CHANNEL_BATCH_MAX_CHARS, 24_000);
      const high = parseConfig({
        ...ENABLED,
        CHANNEL_BATCH_WINDOW_MS: '60000',
        CHANNEL_BATCH_MAX_WAIT_MS: '300000',
        CHANNEL_BATCH_MAX_MESSAGES: '1',
        CHANNEL_BATCH_MAX_CHARS: '1',
      });
      assert.ok(high.ok);
    });

    it('rejeita valor fora da faixa, não inteiro ou não numérico, citando a variável', () => {
      for (const [name, value] of [
        ['CHANNEL_BATCH_WINDOW_MS', '-1'],
        ['CHANNEL_BATCH_WINDOW_MS', '60001'],
        ['CHANNEL_BATCH_WINDOW_MS', '1.5'],
        ['CHANNEL_BATCH_WINDOW_MS', 'abc'],
        ['CHANNEL_BATCH_MAX_WAIT_MS', '-1'],
        ['CHANNEL_BATCH_MAX_WAIT_MS', '300001'],
        ['CHANNEL_BATCH_MAX_MESSAGES', '0'],
        ['CHANNEL_BATCH_MAX_MESSAGES', '51'],
        ['CHANNEL_BATCH_MAX_CHARS', '0'],
        ['CHANNEL_BATCH_MAX_CHARS', '24001'],
      ] as const) {
        const result = parseConfig({ ...ENABLED, [name]: value });
        assert.equal(result.ok, false, `${name}=${value}`);
        assert.match(result.error.message, new RegExp(name));
      }
    });

    it('CHANNEL_BATCH_MAX_WAIT_MS menor que a janela é rejeitado; igual passa', () => {
      const bad = parseConfig({
        ...ENABLED,
        CHANNEL_BATCH_WINDOW_MS: '8000',
        CHANNEL_BATCH_MAX_WAIT_MS: '7999',
      });
      assert.equal(bad.ok, false);
      assert.match(bad.error.message, /CHANNEL_BATCH_MAX_WAIT_MS/);
      assert.ok(
        parseConfig({
          ...ENABLED,
          CHANNEL_BATCH_WINDOW_MS: '8000',
          CHANNEL_BATCH_MAX_WAIT_MS: '8000',
        }).ok,
      );
      // Com o canal desligado a regra cruzada não se aplica (como a do backoff da fila).
      assert.ok(
        parseConfig({
          ...VALID_ENV,
          CHANNEL_BATCH_WINDOW_MS: '8000',
          CHANNEL_BATCH_MAX_WAIT_MS: '1000',
        }).ok,
      );
    });
  });
});
