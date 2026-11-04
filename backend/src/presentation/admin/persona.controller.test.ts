import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { CompanyService } from '../../application/companies/company.service.js';
import {
  type Company,
  MEMBERSHIP_ROLES,
  type MembershipRole,
  PERSONA_MAX_LENGTH,
} from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains, type LogCapture } from '../../test-support/log-capture.js';

const SECRET_PERSONA = `Persona secreta ${randomUUID()}`;
const SECRET_MESSAGE = `mensagem secreta ${randomUUID()}`;
const APP_SECRET = `segredo-do-app-${randomUUID()}`;
const LEGACY_TOKEN = `token-legado-${randomUUID()}`;
const CIPHER_KEY = `chave-de-cifra-${randomUUID()}`;

/** Corpo de erro sem o `requestId` (muda a cada resposta). */
function errorOf(body: string): { code: string; message: string } {
  const { error } = JSON.parse(body) as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

describe('persona da empresa e setup do canal (spec 023)', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let metrics: Metrics;
  let logs: LogCapture;
  let companies: InMemoryCompanyRepository;
  let llm: MockLlmProvider;
  let companyA: Company;
  let companyB: Company;
  const tokens = new Map<MembershipRole, { authorization: string }>();
  let ownerB: { authorization: string };
  let platform: { authorization: string };

  before(async () => {
    logs = captureLogs();
    metrics = createMetrics();
    companies = new InMemoryCompanyRepository();
    testAuth = buildTestAuth({ logger: logs.logger, companies, metrics });
    const store = new InMemoryAttendanceStore();
    llm = new MockLlmProvider({ recordCalls: true });
    app = buildServer({
      logger: logs.logger,
      metrics,
      metricsToken: 'm'.repeat(40),
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      auth: testAuth.service,
      admin: {
        companies: new CompanyService(companies),
        attendance: new AttendanceService({
          companies,
          conversations: store.conversations,
          messages: store.messages,
          unitOfWork: store,
          llm,
          logger: logs.logger,
          metrics,
          options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000 },
        }),
        channel: {
          getState: () => Promise.reject(new Error('fora do escopo deste teste')),
          connect: () => Promise.reject(new Error('fora do escopo deste teste')),
          disconnect: () => Promise.reject(new Error('fora do escopo deste teste')),
          embeddedSignup: () => Promise.reject(new Error('fora do escopo deste teste')),
        },
        channelSetup: {
          appId: '1234567890123',
          embeddedSignupConfigId: '98765432100',
          graphApiVersion: 'v26.0',
          manualConnect: true,
        },
      },
    });
    await app.ready();
    companyA = await companies.create({ name: 'A', slug: 'empresa-a' });
    companyB = await companies.create({ name: 'B', slug: 'empresa-b' });
    for (const role of MEMBERSHIP_ROLES) {
      tokens.set(role, bearer((await testAuth.membershipToken(companyA.id, { role })).accessToken));
    }
    ownerB = bearer((await testAuth.membershipToken(companyB.id, { role: 'OWNER' })).accessToken);
    platform = bearer((await testAuth.platformToken()).accessToken);
  });
  after(async () => {
    await app.close();
  });

  const persona = (companyId: string, role: { authorization: string } | undefined) =>
    app.inject({
      method: 'GET',
      url: `/admin/companies/${companyId}/persona`,
      ...(role === undefined ? {} : { headers: role }),
    });
  const putPersona = (
    companyId: string,
    role: { authorization: string } | undefined,
    payload: unknown,
  ) =>
    app.inject({
      method: 'PUT',
      url: `/admin/companies/${companyId}/persona`,
      ...(role === undefined ? {} : { headers: role }),
      payload: payload as object,
    });

  describe('persona:manage', () => {
    for (const role of MEMBERSHIP_ROLES) {
      const allowed = role === 'OWNER' || role === 'ADMIN';
      it(`${role} ${allowed ? 'lê e grava' : 'leva 403 em GET e PUT'}`, async () => {
        const get = await persona(companyA.id, tokens.get(role));
        const put = await putPersona(companyA.id, tokens.get(role), { persona: null });
        if (allowed) {
          assert.equal(get.statusCode, 200);
          assert.equal(put.statusCode, 200);
        } else {
          assert.equal(get.statusCode, 403);
          assert.equal(put.statusCode, 403);
          assert.equal(errorOf(put.body).code, 'FORBIDDEN');
        }
      });
    }

    it('sem token 401; PlatformAdmin 403', async () => {
      assert.equal((await persona(companyA.id, undefined)).statusCode, 401);
      assert.equal((await persona(companyA.id, platform)).statusCode, 403);
      assert.equal((await putPersona(companyA.id, platform, { persona: 'x' })).statusCode, 403);
    });

    it('empresa alheia ou inexistente: o MESMO 404 (sem requestId na comparação)', async () => {
      const ghost = randomUUID();
      const bodies = new Set<string>();
      for (const role of MEMBERSHIP_ROLES) {
        for (const id of [companyB.id, ghost]) {
          const get = await persona(id, tokens.get(role));
          const put = await putPersona(id, tokens.get(role), { persona: 'nao-grava' });
          assert.equal(get.statusCode, 404, `${role} GET`);
          assert.equal(put.statusCode, 404, `${role} PUT`);
          bodies.add(JSON.stringify(errorOf(get.body)));
          bodies.add(JSON.stringify(errorOf(put.body)));
        }
      }
      assert.equal(bodies.size, 1);
    });
  });

  describe('gravação', () => {
    it('PUT grava e GET devolve; null limpa; o texto vem aparado', async () => {
      const owner = tokens.get('OWNER');
      const put = await putPersona(companyA.id, owner, { persona: `  ${SECRET_PERSONA}  ` });
      assert.equal(put.statusCode, 200);
      assert.deepEqual(put.json(), { persona: SECRET_PERSONA });
      assert.deepEqual((await persona(companyA.id, owner)).json(), { persona: SECRET_PERSONA });
      const cleared = await putPersona(companyA.id, owner, { persona: null });
      assert.deepEqual(cleared.json(), { persona: null });
      assert.deepEqual((await persona(companyA.id, owner)).json(), { persona: null });
    });

    it('recusa vazio, só espaços, NUL, 4001 caracteres, campo extra e corpo sem persona (400)', async () => {
      const owner = tokens.get('OWNER');
      const invalid: unknown[] = [
        { persona: '' },
        { persona: '   \n  ' },
        { persona: `a${String.fromCharCode(0)}b` },
        { persona: 'a'.repeat(PERSONA_MAX_LENGTH + 1) },
        { persona: 'ok', companyId: companyB.id },
        { persona: 'ok', name: 'Outro nome' },
        {},
        { persona: 42 },
      ];
      for (const payload of invalid) {
        const response = await putPersona(companyA.id, owner, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 60));
      }
      assert.equal(
        (await putPersona(companyA.id, owner, { persona: 'a'.repeat(PERSONA_MAX_LENGTH) }))
          .statusCode,
        200,
      );
    });

    it('a persona gravada chega ao LlmProvider na próxima mensagem do simulador', async () => {
      const owner = tokens.get('OWNER');
      await putPersona(companyA.id, owner, { persona: SECRET_PERSONA });
      const sent = await app.inject({
        method: 'POST',
        url: `/admin/companies/${companyA.id}/messages`,
        headers: owner as { authorization: string },
        payload: { contactRef: 'teste-no-site', text: SECRET_MESSAGE },
      });
      assert.equal(sent.statusCode, 201);
      const last = llm.calls.at(-1);
      assert.ok(last);
      assert.ok(last.systemPrompt.includes(SECRET_PERSONA));
      await putPersona(companyA.id, owner, { persona: null });
    });

    it('isolamento: o OWNER de A só mexe na persona de A; a de B segue intacta', async () => {
      await putPersona(companyB.id, ownerB, { persona: 'persona de B' });
      await putPersona(companyA.id, tokens.get('OWNER'), { persona: 'persona de A' });
      // Tentativas por caminho de B e por corpo adulterado.
      assert.equal(
        (await putPersona(companyB.id, tokens.get('OWNER'), { persona: 'invasao' })).statusCode,
        404,
      );
      assert.equal(
        (
          await putPersona(companyA.id, tokens.get('OWNER'), {
            persona: 'invasao',
            companyId: companyB.id,
          })
        ).statusCode,
        400,
      );
      assert.deepEqual((await persona(companyB.id, ownerB)).json(), { persona: 'persona de B' });
      assert.deepEqual((await persona(companyA.id, tokens.get('OWNER'))).json(), {
        persona: 'persona de A',
      });
      await putPersona(companyA.id, tokens.get('OWNER'), { persona: null });
      await putPersona(companyB.id, ownerB, { persona: null });
    });
  });

  describe('GET .../channel/setup', () => {
    const setup = (companyId: string, role: { authorization: string } | undefined) =>
      app.inject({
        method: 'GET',
        url: `/admin/companies/${companyId}/channel/setup`,
        ...(role === undefined ? {} : { headers: role }),
      });

    it('OWNER e ADMIN recebem só valores públicos; AGENT e VIEWER 403; plataforma 403', async () => {
      for (const role of MEMBERSHIP_ROLES) {
        const response = await setup(companyA.id, tokens.get(role));
        if (role === 'OWNER' || role === 'ADMIN') {
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.json(), {
            embeddedSignup: {
              appId: '1234567890123',
              configId: '98765432100',
              graphApiVersion: 'v26.0',
            },
            manualConnect: true,
          });
          for (const secret of [APP_SECRET, LEGACY_TOKEN, CIPHER_KEY]) {
            assert.ok(!response.body.includes(secret));
          }
        } else {
          assert.equal(response.statusCode, 403, role);
        }
      }
      assert.equal((await setup(companyA.id, undefined)).statusCode, 401);
      assert.equal((await setup(companyA.id, platform)).statusCode, 403);
    });

    it('empresa alheia: 404 idêntico ao de empresa inexistente', async () => {
      const alien = await setup(companyB.id, tokens.get('OWNER'));
      const ghost = await setup(randomUUID(), tokens.get('OWNER'));
      assert.equal(alien.statusCode, 404);
      assert.deepEqual(errorOf(alien.body), errorOf(ghost.body));
    });
  });

  it('sem config_id o embeddedSignup é null; sem channelSetup a rota não existe (404)', async () => {
    const make = async (
      channelSetup: { manualConnect: boolean; embeddedSignupConfigId?: string } | undefined,
    ): Promise<{ statusCode: number; body: string }> => {
      const localCompanies = new InMemoryCompanyRepository();
      const local = buildTestAuth({ logger: logs.logger, companies: localCompanies });
      const server = buildServer({
        logger: logs.logger,
        readiness: {
          database: () => Promise.resolve(Result.ok(undefined)),
          redis: () => Promise.resolve(Result.ok(undefined)),
        },
        auth: local.service,
        admin: {
          companies: new CompanyService(localCompanies),
          channel: {
            getState: () => Promise.reject(new Error('x')),
            connect: () => Promise.reject(new Error('x')),
            disconnect: () => Promise.reject(new Error('x')),
            embeddedSignup: () => Promise.reject(new Error('x')),
          },
          ...(channelSetup === undefined
            ? {}
            : {
                channelSetup: {
                  appId: '1',
                  embeddedSignupConfigId: channelSetup.embeddedSignupConfigId,
                  graphApiVersion: 'v26.0',
                  manualConnect: channelSetup.manualConnect,
                },
              }),
        },
      });
      try {
        await server.ready();
        const company = await localCompanies.create({ name: 'L', slug: 'empresa-l' });
        const token = bearer((await local.membershipToken(company.id)).accessToken);
        return await server.inject({
          method: 'GET',
          url: `/admin/companies/${company.id}/channel/setup`,
          headers: token,
        });
      } finally {
        await server.close();
      }
    };
    const without = await make({ manualConnect: false });
    assert.equal(without.statusCode, 200);
    assert.deepEqual(JSON.parse(without.body), { embeddedSignup: null, manualConnect: false });
    assert.equal((await make(undefined)).statusCode, 404);
  });

  describe('privacidade', () => {
    it('log e métricas nunca têm a persona nem o texto das mensagens; só o label action', async () => {
      await putPersona(companyA.id, tokens.get('OWNER'), { persona: SECRET_PERSONA });
      await putPersona(companyA.id, tokens.get('OWNER'), { persona: null });
      await app.inject({
        method: 'POST',
        url: `/admin/companies/${companyA.id}/messages`,
        headers: tokens.get('OWNER') as { authorization: string },
        payload: { contactRef: 'teste-no-site', text: SECRET_MESSAGE },
      });
      const raw = logs.raw();
      assert.ok(!logContains(raw, SECRET_PERSONA));
      assert.ok(!logContains(raw, SECRET_MESSAGE));
      assert.ok(logs.lines().some((line) => line.msg === 'persona da empresa atualizada'));
      const body = await metrics.render();
      assert.match(body, /company_persona_updates_total\{action="set"\} \d+/);
      assert.match(body, /company_persona_updates_total\{action="cleared"\} \d+/);
      assert.ok(!body.includes(SECRET_PERSONA));
      for (const line of body.split('\n')) {
        if (line.startsWith('company_persona_updates_total{')) {
          assert.match(line, /^company_persona_updates_total\{action="(set|cleared)"\} \d+$/);
        }
      }
    });
  });
});
