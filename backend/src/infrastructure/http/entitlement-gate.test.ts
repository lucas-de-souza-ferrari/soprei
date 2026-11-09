import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { EntitlementReader } from '../../application/ports/entitlement-reader.js';
import { CompanyService } from '../../application/companies/company.service.js';
import type { InventoryService } from '../../application/inventory/inventory.service.js';
import {
  type Company,
  type CompanyEntitlements,
  MEMBERSHIP_ROLES,
  type MembershipRole,
  UNLIMITED_ENTITLEMENTS,
} from '../../domain/index.js';
import { createMetrics } from '../metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { buildServer } from './server.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

describe('política de assinatura das escritas de tenant e rota de entitlements (spec 031, E1/E2)', () => {
  let logs: LogCapture;
  let companyA: Company;
  let companyB: Company;
  let current: CompanyEntitlements = UNLIMITED_ENTITLEMENTS;
  let readerFails = false;
  let readerCalls = 0;
  const writes: string[] = [];
  const tokens = new Map<MembershipRole, { authorization: string }>();
  let platform: { authorization: string };
  let withBilling: FastifyInstance;
  let withoutBilling: FastifyInstance;

  const reader: EntitlementReader = {
    forCompany() {
      readerCalls += 1;
      return readerFails ? Promise.reject(new Error('banco fora')) : Promise.resolve(current);
    },
  };

  const inventory = {
    list: () => Promise.resolve({ items: [], nextCursor: null }),
    create: () => {
      writes.push('create');
      return Promise.resolve({
        id: randomUUID(),
        companyId: companyA.id,
        sku: 'CAM-1',
        name: 'x',
        description: '',
        priceCents: 100,
        quantity: 1,
        lowStockThreshold: 0,
        active: true,
        isSample: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
  } as unknown as InventoryService;

  before(async () => {
    logs = captureLogs();
    const companies = new InMemoryCompanyRepository();
    const testAuth = buildTestAuth({ logger: logs.logger, companies, metrics: createMetrics() });
    const build = (billing: boolean): FastifyInstance =>
      buildServer({
        logger: logs.logger,
        readiness: {
          database: () => Promise.resolve(Result.ok(undefined)),
          redis: () => Promise.resolve(Result.ok(undefined)),
        },
        auth: testAuth.service,
        admin: { companies: new CompanyService(companies), inventory },
        ...(billing
          ? {
              billing: {
                service: { overview: () => Promise.reject(new Error('n/a')) },
                entitlements: reader,
              },
            }
          : {}),
      });
    withBilling = build(true);
    withoutBilling = build(false);
    await withBilling.ready();
    await withoutBilling.ready();
    companyA = await companies.create({ name: 'A', slug: 'empresa-a' });
    companyB = await companies.create({ name: 'B', slug: 'empresa-b' });
    for (const role of MEMBERSHIP_ROLES) {
      tokens.set(role, bearer((await testAuth.membershipToken(companyA.id, { role })).accessToken));
    }
    platform = bearer((await testAuth.platformToken()).accessToken);
  });
  after(async () => {
    await withBilling.close();
    await withoutBilling.close();
  });

  const owner = (): { authorization: string } => {
    const token = tokens.get('OWNER');
    assert.ok(token !== undefined);
    return token;
  };
  const post = (
    app: FastifyInstance,
    headers?: { authorization: string },
    company: Company = companyA,
  ) =>
    app.inject({
      method: 'POST',
      url: `/admin/companies/${company.id}/inventory/products`,
      ...(headers === undefined ? {} : { headers }),
      payload: { sku: 'cam-001', name: 'x', priceCents: 100, quantity: 1 },
    });
  const putPersona = (app: FastifyInstance, headers?: { authorization: string }) =>
    app.inject({
      method: 'PUT',
      url: `/admin/companies/${companyA.id}/persona`,
      ...(headers === undefined ? {} : { headers }),
      payload: { persona: 'Persona de teste' },
    });

  it('sem cobrança (BILLING_ENABLED=false): nada é barrado, o leitor nem existe e entitlements devolve tudo liberado e sem cota', async () => {
    current = { ...UNLIMITED_ENTITLEMENTS, access: 'blocked', stock: false };
    readerCalls = 0;
    assert.equal((await post(withoutBilling, owner())).statusCode, 201);
    assert.equal((await putPersona(withoutBilling, owner())).statusCode, 200);
    assert.equal(readerCalls, 0);
    const response = await withoutBilling.inject({
      method: 'GET',
      url: `/admin/companies/${companyA.id}/entitlements`,
      headers: tokens.get('VIEWER') ?? owner(),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), UNLIMITED_ENTITLEMENTS);
  });

  it('assinatura inativa: escrita 403 SUBSCRIPTION_INACTIVE; leitura segue 200; nada é gravado', async () => {
    current = { access: 'blocked', agenda: true, stock: true, tokens: null, replies: null };
    writes.length = 0;
    const blocked = await post(withBilling, owner());
    assert.equal(blocked.statusCode, 403);
    assert.equal(errorCode(blocked.body), 'SUBSCRIPTION_INACTIVE');
    const persona = await putPersona(withBilling, owner());
    assert.equal(persona.statusCode, 403);
    assert.equal(errorCode(persona.body), 'SUBSCRIPTION_INACTIVE');
    assert.deepEqual(writes, []);
    const list = await withBilling.inject({
      method: 'GET',
      url: `/admin/companies/${companyA.id}/inventory/products`,
      headers: owner(),
    });
    assert.equal(list.statusCode, 200);
  });

  it('carência (grace) segue liberada; módulo ausente barra só a escrita do módulo', async () => {
    current = { access: 'grace', agenda: true, stock: false, tokens: null, replies: null };
    assert.equal((await putPersona(withBilling, owner())).statusCode, 200);
    const noModule = await post(withBilling, owner());
    assert.equal(noModule.statusCode, 403);
    assert.equal(errorCode(noModule.body), 'MODULE_NOT_CONTRACTED');
    const read = await withBilling.inject({
      method: 'GET',
      url: `/admin/companies/${companyA.id}/inventory/products`,
      headers: owner(),
    });
    assert.equal(read.statusCode, 200);
    current = { access: 'ok', agenda: false, stock: true, tokens: null, replies: null };
    assert.equal((await post(withBilling, owner())).statusCode, 201);
  });

  it('ordem de recusa: 401 -> 403 plataforma -> 404 -> 403 papel -> 403 módulo', async () => {
    current = { access: 'ok', agenda: true, stock: false, tokens: null, replies: null };
    assert.equal((await post(withBilling, undefined)).statusCode, 401);
    assert.equal(errorCode((await post(withBilling, platform)).body), 'FORBIDDEN');
    // `:companyId` alheio: 404 antes do papel e do módulo.
    assert.equal((await post(withBilling, tokens.get('VIEWER'), companyB)).statusCode, 404);
    // Papel sem permissão vence o módulo: 403 FORBIDDEN, não MODULE_NOT_CONTRACTED.
    const role = await post(withBilling, tokens.get('VIEWER'));
    assert.equal(role.statusCode, 403);
    assert.equal(errorCode(role.body), 'FORBIDDEN');
    assert.equal(errorCode((await post(withBilling, owner())).body), 'MODULE_NOT_CONTRACTED');
  });

  it('falha ao ler a assinatura é fail-open para a escrita, com warn só do padrão da rota', async () => {
    readerFails = true;
    try {
      assert.equal((await putPersona(withBilling, owner())).statusCode, 200);
    } finally {
      readerFails = false;
    }
    const warned = logs
      .lines()
      .some((line) => String(line.msg).includes('assinatura indisponível; escrita liberada'));
    assert.equal(warned, true);
  });

  it('entitlements: qualquer papel lê, sem dinheiro; 401 sem token; 404 de empresa alheia; plataforma 403; segue com a assinatura bloqueada', async () => {
    current = {
      access: 'blocked',
      agenda: false,
      stock: true,
      tokens: { used: 5, limit: 10 },
      replies: { used: 1, limit: 8 },
    };
    const url = `/admin/companies/${companyA.id}/entitlements`;
    for (const role of MEMBERSHIP_ROLES) {
      const response = await withBilling.inject({ method: 'GET', url, headers: tokens.get(role) });
      assert.equal(response.statusCode, 200, role);
      assert.deepEqual(JSON.parse(response.body), current);
      assert.doesNotMatch(response.body, /cents|price|valor/i);
    }
    assert.equal((await withBilling.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal(
      (await withBilling.inject({ method: 'GET', url, headers: platform })).statusCode,
      403,
    );
    assert.equal(
      (
        await withBilling.inject({
          method: 'GET',
          url: `/admin/companies/${companyB.id}/entitlements`,
          headers: tokens.get('OWNER'),
        })
      ).statusCode,
      404,
    );
  });
});
