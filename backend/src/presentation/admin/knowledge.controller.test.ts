import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import {
  type Company,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  KNOWLEDGE_MAX_DOCUMENTS,
  MEMBERSHIP_ROLES,
  type MembershipRole,
} from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { InMemoryKnowledgeDocumentRepository } from '../../test-support/in-memory-knowledge.js';
import { captureLogs, logContains, type LogCapture } from '../../test-support/log-capture.js';

const SECRET_TITLE = `Titulo secreto ${randomUUID()}`;
const SECRET_TEXT = `Texto secreto do documento ${randomUUID()}`;

/** Corpo de erro sem o `requestId` (muda a cada resposta). */
function errorOf(body: string): { code: string; message: string } {
  const { error } = JSON.parse(body) as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

describe('API da base de conhecimento (spec 026)', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let logs: LogCapture;
  let repository: InMemoryKnowledgeDocumentRepository;
  let companies: InMemoryCompanyRepository;
  let companyA: Company;
  let companyB: Company;
  const tokens = new Map<MembershipRole, { authorization: string }>();
  let ownerB: { authorization: string };
  let platform: { authorization: string };

  before(async () => {
    logs = captureLogs();
    const metrics = createMetrics();
    companies = new InMemoryCompanyRepository();
    testAuth = buildTestAuth({ logger: logs.logger, companies, metrics });
    repository = new InMemoryKnowledgeDocumentRepository();
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
        knowledge: new KnowledgeService(repository),
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

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers?: { authorization: string },
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const base = (company: Company) => `/admin/companies/${company.id}/knowledge/documents`;
  const owner = (): { authorization: string } => {
    const token = tokens.get('OWNER');
    assert.ok(token !== undefined);
    return token;
  };

  it('OWNER e ADMIN operam; AGENT, VIEWER e PlatformAdmin recebem 403; sem token, 401', async () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      assert.equal((await call('GET', base(companyA), tokens.get(role))).statusCode, 200, role);
    }
    for (const role of ['AGENT', 'VIEWER'] as const) {
      assert.equal((await call('GET', base(companyA), tokens.get(role))).statusCode, 403, role);
      const post = await call('POST', base(companyA), tokens.get(role), {
        title: 't',
        content: 'c',
      });
      assert.equal(post.statusCode, 403, role);
    }
    assert.equal((await call('GET', base(companyA), platform)).statusCode, 403);
    assert.equal((await call('GET', base(companyA))).statusCode, 401);
  });

  it(':companyId divergente do token é 404, antes do 403 (mesmo para papel sem permissão)', async () => {
    assert.equal((await call('GET', base(companyB), owner())).statusCode, 404);
    assert.equal((await call('GET', base(companyB), tokens.get('VIEWER'))).statusCode, 404);
  });

  it('cria, lista (só pré-visualização) e apaga; o texto inteiro nunca volta', async () => {
    const created = await call('POST', base(companyA), owner(), {
      title: `  ${SECRET_TITLE}  `,
      content: `${SECRET_TEXT}\n\n${'x'.repeat(400)}`,
    });
    assert.equal(created.statusCode, 201);
    const item = created.json<{
      id: string;
      title: string;
      preview: string;
      chunkCount: number;
      charCount: number;
      isSample: boolean;
    }>();
    assert.equal(item.title, SECRET_TITLE);
    assert.equal(item.chunkCount, 1);
    assert.ok(item.preview.length <= 160);
    assert.equal(item.isSample, false);
    assert.ok(!('content' in item));

    const list = await call('GET', base(companyA), owner());
    assert.deepEqual(
      list.json<{ items: { id: string }[] }>().items.map((entry) => entry.id),
      [item.id],
    );
    assert.equal(list.body.includes('x'.repeat(200)), false);

    assert.equal((await call('DELETE', `${base(companyA)}/${item.id}`, owner())).statusCode, 204);
    assert.equal(
      (await call('GET', base(companyA), owner())).json<{ items: unknown[] }>().items.length,
      0,
    );
  });

  it('isolamento: documento de outra empresa não aparece e apagar o id dela é 404 igual a inexistente', async () => {
    const created = await call('POST', base(companyB), ownerB, {
      title: 'B',
      content: 'texto da B',
    });
    const id = created.json<{ id: string }>().id;
    const mine = await call('GET', base(companyA), owner());
    assert.equal(
      mine.json<{ items: { id: string }[] }>().items.some((entry) => entry.id === id),
      false,
    );
    const foreign = await call('DELETE', `${base(companyA)}/${id}`, owner());
    const missing = await call('DELETE', `${base(companyA)}/${randomUUID()}`, owner());
    const malformed = await call('DELETE', `${base(companyA)}/nao-e-uuid`, owner());
    for (const response of [foreign, missing, malformed]) assert.equal(response.statusCode, 404);
    assert.deepEqual(errorOf(foreign.body), errorOf(missing.body));
    assert.deepEqual(errorOf(foreign.body), errorOf(malformed.body));
    // E o documento da B continua lá.
    assert.equal(
      (await call('GET', base(companyB), ownerB)).json<{ items: unknown[] }>().items.length,
      1,
    );
  });

  it('validação estrita: campo extra, título vazio e texto vazio são 400 sem ecoar o valor', async () => {
    const bodies: unknown[] = [
      { title: 'a', content: 'b', companyId: companyB.id },
      { title: '   ', content: 'b' },
      { title: 'a', content: '' },
      { title: 'a', content: '  \n ' },
      { title: 'a'.repeat(121), content: 'b' },
      { title: 'a' },
      { title: 'a', content: `${SECRET_TEXT}\u0000` },
    ];
    for (const body of bodies) {
      const response = await call('POST', base(companyA), owner(), body);
      assert.equal(response.statusCode, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(response.body.includes(SECRET_TEXT), false);
    }
  });

  it('texto acima de 100.000 caracteres ou de 150 trechos: 400 KNOWLEDGE_DOCUMENT_TOO_LARGE', async () => {
    const huge = await call('POST', base(companyA), owner(), {
      title: 'grande',
      content: 'a'.repeat(KNOWLEDGE_CONTENT_MAX_LENGTH + 1),
    });
    assert.equal(huge.statusCode, 400);
    assert.equal(errorOf(huge.body).code, 'KNOWLEDGE_DOCUMENT_TOO_LARGE');
    const paragraph = 'q'.repeat(700);
    const many = Array.from({ length: 151 }, () => paragraph).join('\n\n');
    const chunks = await call('POST', base(companyA), owner(), { title: 'muitos', content: many });
    assert.equal(chunks.statusCode, 400);
    assert.equal(errorOf(chunks.body).code, 'KNOWLEDGE_DOCUMENT_TOO_LARGE');
  });

  it('limite de documentos por empresa: 409 KNOWLEDGE_LIMIT_REACHED', async () => {
    const company = await companyId('limite');
    const headers = bearer(
      (await testAuth.membershipToken(company.id, { role: 'OWNER' })).accessToken,
    );
    for (let index = 0; index < KNOWLEDGE_MAX_DOCUMENTS; index += 1) {
      const response = await call('POST', base(company), headers, {
        title: `d${String(index)}`,
        content: 'texto',
      });
      assert.equal(response.statusCode, 201);
    }
    const over = await call('POST', base(company), headers, { title: 'a mais', content: 'texto' });
    assert.equal(over.statusCode, 409);
    assert.equal(errorOf(over.body).code, 'KNOWLEDGE_LIMIT_REACHED');
  });

  it('nenhum título nem texto vai a log', () => {
    for (const secret of [SECRET_TITLE, SECRET_TEXT]) {
      assert.equal(logContains(logs.raw(), secret), false);
    }
  });

  const cache = new Map<string, Company>();
  async function companyId(slug: string): Promise<Company> {
    const known = cache.get(slug);
    if (known !== undefined) return known;
    const created = await companies.create({ name: slug, slug });
    cache.set(slug, created);
    return created;
  }
});
