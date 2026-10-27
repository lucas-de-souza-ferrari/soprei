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

  describe('ADMIN_API_KEY', () => {
    const KEY = 'a'.repeat(32);

    it('é opcional em desenvolvimento e em teste', () => {
      for (const NODE_ENV of ['development', 'test']) {
        const result = parseConfig({ ...VALID_ENV, NODE_ENV });
        assert.ok(result.ok, NODE_ENV);
        assert.equal(result.value.ADMIN_API_KEY, undefined);
      }
    });

    it('aceita qualquer valor não vazio fora de produção e variável vazia vale como ausente', () => {
      const short = parseConfig({ ...VALID_ENV, ADMIN_API_KEY: 'curta' });
      assert.ok(short.ok);
      assert.equal(short.value.ADMIN_API_KEY, 'curta');
      const empty = parseConfig({ ...VALID_ENV, ADMIN_API_KEY: '' });
      assert.ok(empty.ok);
      assert.equal(empty.value.ADMIN_API_KEY, undefined);
    });

    it('em produção é obrigatória, com mensagem clara', () => {
      const result = parseConfig({ ...VALID_ENV, NODE_ENV: 'production' });
      assert.equal(result.ok, false);
      assert.match(
        result.error.message,
        /ADMIN_API_KEY: obrigatória em produção, com no mínimo 32 caracteres/,
      );
    });

    it('em produção, variável vazia ou com menos de 32 caracteres também falha', () => {
      for (const value of ['', 'a'.repeat(31)]) {
        const result = parseConfig({ ...VALID_ENV, NODE_ENV: 'production', ADMIN_API_KEY: value });
        assert.equal(result.ok, false, value);
        assert.match(result.error.message, /ADMIN_API_KEY/);
        assert.ok(!result.error.message.includes(value) || value === '');
      }
    });

    it('em produção aceita 32 caracteres ou mais', () => {
      for (const value of [KEY, KEY + 'b']) {
        const result = parseConfig({ ...VALID_ENV, NODE_ENV: 'production', ADMIN_API_KEY: value });
        assert.ok(result.ok);
        assert.equal(result.value.ADMIN_API_KEY, value);
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

    it('a regra vale também em produção, junto com a da ADMIN_API_KEY', () => {
      const result = parseConfig({
        ...VALID_ENV,
        NODE_ENV: 'production',
        ADMIN_API_KEY: 'a'.repeat(32),
        METRICS_TOKEN: 'curto',
      });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /METRICS_TOKEN/);
      assert.doesNotMatch(result.error.message, /ADMIN_API_KEY/);
    });
  });

  describe('rate limiting (spec 005)', () => {
    const PRODUCTION = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'a'.repeat(32),
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
      WHATSAPP_ACCESS_TOKEN: 'token-de-envio',
    };
    const PRODUCTION = { ...VALID_ENV, NODE_ENV: 'production', ADMIN_API_KEY: 'a'.repeat(32) };
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
});
