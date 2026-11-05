import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import type { InventoryService } from '../../application/inventory/inventory.service.js';
import {
  type Company,
  type CompanyId,
  MEMBERSHIP_ROLES,
  type MembershipRole,
  type Product,
} from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains, type LogCapture } from '../../test-support/log-capture.js';

const SECRET_NAME = `Produto secreto ${randomUUID()}`;
const SECRET_SKU = `SEC-${randomUUID().slice(0, 8).toUpperCase()}`;

function errorOf(body: string): { code: string; message: string } {
  const { error } = JSON.parse(body) as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

type Calls = { method: string; args: unknown[] }[];

describe('API de estoque (spec 026, E2): permissões e validação', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let logs: LogCapture;
  let companyA: Company;
  let companyB: Company;
  const calls: Calls = [];
  const tokens = new Map<MembershipRole, { authorization: string }>();
  let platform: { authorization: string };

  const product = (companyId: CompanyId): Product => ({
    id: randomUUID(),
    companyId,
    sku: SECRET_SKU,
    name: SECRET_NAME,
    description: '',
    priceCents: 5990,
    quantity: 3,
    lowStockThreshold: 0,
    active: true,
    isSample: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  before(async () => {
    logs = captureLogs();
    const metrics = createMetrics();
    const companies = new InMemoryCompanyRepository();
    testAuth = buildTestAuth({ logger: logs.logger, companies, metrics });
    const record = <T>(method: string, value: T) => {
      return (...args: unknown[]): Promise<T> => {
        calls.push({ method, args });
        return Promise.resolve(value);
      };
    };
    const inventory = {
      list: record('list', { items: [], nextCursor: null }),
      create: (...args: unknown[]) => {
        calls.push({ method: 'create', args });
        return Promise.resolve(product(args[0] as CompanyId));
      },
      update: (...args: unknown[]) => {
        calls.push({ method: 'update', args });
        return Promise.resolve(product(args[0] as CompanyId));
      },
      adjust: (...args: unknown[]) => {
        calls.push({ method: 'adjust', args });
        const delta = (args[3] as { delta: number }).delta;
        if (delta === -999) {
          return Promise.reject(
            new ConflictError('Estoque insuficiente', { code: 'INSUFFICIENT_STOCK' }),
          );
        }
        return Promise.resolve({
          product: product(args[0] as CompanyId),
          movement: {
            id: randomUUID(),
            companyId: args[0] as CompanyId,
            productId: args[2] as string,
            delta,
            quantityAfter: 3,
            reason: 'ENTRY' as const,
            createdByMembershipId: args[1] as string,
            createdAt: new Date(),
          },
        });
      },
      movements: record('movements', { items: [], nextCursor: null }),
      importRows: record('importRows', { created: 0, skipped: [] }),
    } as unknown as InventoryService;
    app = buildServer({
      logger: logs.logger,
      metrics,
      metricsToken: 'm'.repeat(40),
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      auth: testAuth.service,
      admin: { companies: new CompanyService(companies), inventory },
    });
    await app.ready();
    companyA = await companies.create({ name: 'A', slug: 'empresa-a' });
    companyB = await companies.create({ name: 'B', slug: 'empresa-b' });
    for (const role of MEMBERSHIP_ROLES) {
      tokens.set(role, bearer((await testAuth.membershipToken(companyA.id, { role })).accessToken));
    }
    platform = bearer((await testAuth.platformToken()).accessToken);
  });
  after(async () => {
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    headers?: { authorization: string },
    payload?: unknown,
    company: Company = companyA,
  ) =>
    app.inject({
      method,
      url: `/admin/companies/${company.id}/inventory/products${path}`,
      ...(headers === undefined ? {} : { headers }),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const owner = (): { authorization: string } => {
    const token = tokens.get('OWNER');
    assert.ok(token !== undefined);
    return token;
  };
  const valid = { sku: 'cam-001', name: SECRET_NAME, priceCents: 5990, quantity: 3 };

  it('OWNER e ADMIN operam todas as rotas; AGENT, VIEWER e PlatformAdmin recebem 403; sem token, 401', async () => {
    const productId = randomUUID();
    const routes: ['GET' | 'POST' | 'PATCH', string, unknown][] = [
      ['GET', '', undefined],
      ['POST', '', valid],
      ['PATCH', `/${productId}`, { active: false }],
      ['POST', `/${productId}/adjustments`, { delta: 1, reason: 'ENTRY' }],
      ['GET', `/${productId}/movements`, undefined],
      ['POST', '/import', { rows: [{}] }],
    ];
    for (const [method, path, payload] of routes) {
      for (const role of ['OWNER', 'ADMIN'] as const) {
        const response = await call(method, path, tokens.get(role), payload);
        assert.ok(
          response.statusCode < 300,
          `${role} ${method} ${path}: ${String(response.statusCode)}`,
        );
      }
      for (const role of ['AGENT', 'VIEWER'] as const) {
        assert.equal(
          (await call(method, path, tokens.get(role), payload)).statusCode,
          403,
          `${role} ${method} ${path}`,
        );
      }
      assert.equal((await call(method, path, platform, payload)).statusCode, 403);
      assert.equal((await call(method, path, undefined, payload)).statusCode, 401);
      // :companyId divergente do token: 404 antes do 403.
      assert.equal(
        (await call(method, path, tokens.get('VIEWER'), payload, companyB)).statusCode,
        404,
      );
    }
  });

  it('o service recebe só o CompanyId da identidade (nunca o do corpo) e o SKU chega normalizado', async () => {
    calls.length = 0;
    const response = await call('POST', '', owner(), valid);
    assert.equal(response.statusCode, 201);
    const create = calls.find((entry) => entry.method === 'create');
    assert.equal(create?.args[0], companyA.id);
    assert.equal((create.args[2] as { sku: string }).sku, 'CAM-001');
    const extra = await call('POST', '', owner(), { ...valid, companyId: companyB.id });
    assert.equal(extra.statusCode, 400);
  });

  it('validação estrita: quantity/sku no PATCH, preço inválido, delta inválido e campo extra são 400 sem ecoar o valor', async () => {
    const productId = randomUUID();
    const bad: ['POST' | 'PATCH', string, unknown][] = [
      ['PATCH', `/${productId}`, { quantity: 5 }],
      ['PATCH', `/${productId}`, { sku: 'X' }],
      ['PATCH', `/${productId}`, {}],
      ['POST', '', { ...valid, priceCents: -1 }],
      ['POST', '', { ...valid, priceCents: 10.5 }],
      ['POST', '', { ...valid, quantity: 1_000_001 }],
      ['POST', '', { ...valid, sku: 'tem espaço' }],
      ['POST', '', { ...valid, name: '   ' }],
      ['POST', '', { ...valid, extra: SECRET_NAME }],
      ['POST', `/${productId}/adjustments`, { delta: 0, reason: 'ENTRY' }],
      ['POST', `/${productId}/adjustments`, { delta: 1.5, reason: 'ENTRY' }],
      ['POST', `/${productId}/adjustments`, { delta: 1, reason: 'INITIAL' }],
      ['POST', `/${productId}/adjustments`, { delta: 1, reason: 'ENTRY', note: SECRET_NAME }],
      ['POST', `/${productId}/adjustments`, { delta: 100_001, reason: 'ENTRY' }],
      ['POST', '/import', { rows: [] }],
      ['POST', '/import', { rows: Array.from({ length: 201 }, () => ({})) }],
    ];
    for (const [method, path, payload] of bad) {
      const response = await call(method, path, owner(), payload);
      assert.equal(
        response.statusCode,
        400,
        `${method} ${path} ${JSON.stringify(payload).slice(0, 40)}`,
      );
      assert.equal(response.body.includes(SECRET_NAME), false);
    }
  });

  it('409 INSUFFICIENT_STOCK vira o corpo de erro com code e message fixos', async () => {
    const response = await call('POST', `/${randomUUID()}/adjustments`, owner(), {
      delta: -999,
      reason: 'EXIT',
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(errorOf(response.body), {
      code: 'INSUFFICIENT_STOCK',
      message: 'Estoque insuficiente',
    });
  });

  it('o movimento devolvido traz byMe e nunca o id do vínculo; nada de SKU, nome ou preço em log', async () => {
    const response = await call('POST', `/${randomUUID()}/adjustments`, owner(), {
      delta: 1,
      reason: 'ENTRY',
    });
    const body = response.json<{ movement: Record<string, unknown> }>();
    assert.equal(body.movement['byMe'], true);
    assert.ok(!('createdByMembershipId' in body.movement));
    for (const secret of [SECRET_NAME, SECRET_SKU]) {
      assert.equal(logContains(logs.raw(), secret), false);
    }
  });
});
