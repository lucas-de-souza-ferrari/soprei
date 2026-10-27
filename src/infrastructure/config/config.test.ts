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
});
