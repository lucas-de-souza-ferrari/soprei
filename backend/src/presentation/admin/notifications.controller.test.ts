import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { CompanyService } from '../../application/companies/company.service.js';
import { NotificationService } from '../../application/notifications/notification.service.js';
import { type Company, MEMBERSHIP_ROLES, type MembershipRole } from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains, type LogCapture } from '../../test-support/log-capture.js';

// Spec 038: rotas de notificações (matriz de papéis, isolamento e privacidade), com o atendimento real
// em memória e o LLM `mock` gerando o pedido de humano.

const SECRET_TEXT = `quero um atendente ${randomUUID()}`;
const SECRET_PHONE = '5511987654321';

function errorOf(body: string): { code: string } {
  const { error } = JSON.parse(body) as { error: { code: string } };
  return { code: error.code };
}

interface NotificationItem {
  id: string;
  kind: string;
  reason: string | null;
  status: string;
  conversation: { id: string; contactLabel: string; channel: string } | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByMe: boolean;
}

describe('API de notificações (spec 038)', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let logs: LogCapture;
  let store: InMemoryAttendanceStore;
  let companyA: Company;
  let companyB: Company;
  const tokens = new Map<MembershipRole, { authorization: string }>();
  let ownerB: { authorization: string };
  let platform: { authorization: string };

  const base = (company: Company) => `/admin/companies/${company.id}`;
  const as = (role: MembershipRole) => {
    const token = tokens.get(role);
    assert.ok(token);
    return token;
  };

  async function simulate(company: Company, headers: { authorization: string }, text: string) {
    const response = await app.inject({
      method: 'POST',
      url: `${base(company)}/messages`,
      headers,
      payload: { contactRef: SECRET_PHONE, text },
    });
    assert.ok(response.statusCode === 201 || response.statusCode === 200, response.body);
    return JSON.parse(response.body) as { conversationId: string };
  }

  async function list(company: Company, headers: { authorization: string }, query = '') {
    const response = await app.inject({
      method: 'GET',
      url: `${base(company)}/notifications${query}`,
      headers,
    });
    return response;
  }

  before(async () => {
    logs = captureLogs();
    const metrics = createMetrics();
    const companies = new InMemoryCompanyRepository();
    testAuth = buildTestAuth({ logger: logs.logger, companies, metrics });
    store = new InMemoryAttendanceStore();
    const attendance = new AttendanceService({
      companies,
      conversations: store.conversations,
      messages: store.messages,
      unitOfWork: store,
      llm: new MockLlmProvider(),
      logger: logs.logger,
      metrics,
      options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000, handoffEnabled: true },
    });
    const notifications = new NotificationService({
      notifications: store.notifications,
      logger: logs.logger,
      metrics,
    });
    app = buildServer({
      logger: logs.logger,
      metrics,
      metricsToken: 'm'.repeat(40),
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      auth: testAuth.service,
      admin: { companies: new CompanyService(companies), attendance, notifications },
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

  it('o pedido de humano no simulador abre uma notificação; a lista e o resumo a mostram sem dado pessoal', async () => {
    const { conversationId } = await simulate(companyA, as('AGENT'), SECRET_TEXT);
    const summary = await app.inject({
      method: 'GET',
      url: `${base(companyA)}/notifications/summary`,
      headers: as('VIEWER'),
    });
    assert.equal(summary.statusCode, 200);
    assert.deepEqual(JSON.parse(summary.body), { open: 1 });

    const response = await list(companyA, as('VIEWER'));
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { items: NotificationItem[]; nextCursor: null };
    assert.equal(body.items.length, 1);
    const [item] = body.items;
    assert.ok(item);
    assert.equal(item.kind, 'HUMAN_HANDOFF');
    assert.equal(item.reason, 'CONTACT_REQUESTED');
    assert.equal(item.status, 'OPEN');
    assert.deepEqual(item.conversation, {
      id: conversationId,
      contactLabel: 'Contato final 4321',
      channel: 'whatsapp',
    });
    assert.equal(item.resolvedByMe, false);
    // Privacidade: nem telefone, nem texto do contato, nem campos internos.
    for (const forbidden of [SECRET_PHONE, SECRET_TEXT, 'contactRef', 'externalId', 'messageId']) {
      assert.equal(response.body.includes(forbidden), false, forbidden);
    }
    assert.equal(logContains(logs.raw(), SECRET_TEXT), false);
  });

  it('conversas: a lista traz openHandoff e o histórico traz o id da notificação aberta', async () => {
    const conversations = await app.inject({
      method: 'GET',
      url: `${base(companyA)}/conversations`,
      headers: as('VIEWER'),
    });
    const items = (
      JSON.parse(conversations.body) as { items: { id: string; openHandoff: boolean }[] }
    ).items;
    assert.equal(items.length, 1);
    const [conversation] = items;
    assert.ok(conversation);
    assert.equal(conversation.openHandoff, true);
    const history = await app.inject({
      method: 'GET',
      url: `${base(companyA)}/conversations/${conversation.id}/messages`,
      headers: as('VIEWER'),
    });
    const { conversation: detail } = JSON.parse(history.body) as {
      conversation: { openHandoff: { notificationId: string; reason: string } | null };
    };
    assert.ok(detail.openHandoff);
    assert.equal(detail.openHandoff.reason, 'CONTACT_REQUESTED');
    const [row] = store.notifications.all();
    assert.equal(detail.openHandoff.notificationId, row?.id);
  });

  it('isolamento: a empresa B não vê nem resolve a notificação de A; :companyId alheio é 404', async () => {
    const [row] = store.notifications.all();
    assert.ok(row);
    const listB = await list(companyB, ownerB);
    assert.deepEqual(JSON.parse(listB.body), { items: [], nextCursor: null });
    const resolveB = await app.inject({
      method: 'POST',
      url: `${base(companyB)}/notifications/${row.id}/resolve`,
      headers: ownerB,
    });
    assert.equal(resolveB.statusCode, 404);
    const foreign = await list(companyA, ownerB);
    assert.equal(foreign.statusCode, 404);
    const foreignResolve = await app.inject({
      method: 'POST',
      url: `${base(companyA)}/notifications/${row.id}/resolve`,
      headers: ownerB,
    });
    assert.equal(foreignResolve.statusCode, 404);
    assert.equal(store.notifications.all()[0]?.status, 'OPEN');
  });

  it('permissões: VIEWER lê e não resolve; plataforma 403; sem token 401', async () => {
    const [row] = store.notifications.all();
    assert.ok(row);
    const viewer = await app.inject({
      method: 'POST',
      url: `${base(companyA)}/notifications/${row.id}/resolve`,
      headers: as('VIEWER'),
    });
    assert.equal(viewer.statusCode, 403);
    assert.equal((await list(companyA, platform)).statusCode, 403);
    const anonymous = await app.inject({ method: 'GET', url: `${base(companyA)}/notifications` });
    assert.equal(anonymous.statusCode, 401);
    for (const role of MEMBERSHIP_ROLES) {
      assert.equal((await list(companyA, as(role))).statusCode, 200, role);
    }
  });

  it('AGENT resolve (204), repetir é 204 e mantém quem resolveu; a lista de abertas fica vazia', async () => {
    const [row] = store.notifications.all();
    assert.ok(row);
    const url = `${base(companyA)}/notifications/${row.id}/resolve`;
    const first = await app.inject({ method: 'POST', url, headers: as('AGENT') });
    assert.equal(first.statusCode, 204);
    const again = await app.inject({ method: 'POST', url, headers: as('OWNER') });
    assert.equal(again.statusCode, 204);
    assert.equal(
      (JSON.parse((await list(companyA, as('AGENT'))).body) as { items: [] }).items.length,
      0,
    );
    const resolved = await list(companyA, as('AGENT'), '?status=resolved');
    const [item] = (JSON.parse(resolved.body) as { items: NotificationItem[] }).items;
    assert.equal(item?.status, 'RESOLVED');
    assert.equal(item.resolvedByMe, true);
    assert.equal(resolved.body.includes('resolvedByMembershipId'), false);
    const byOwner = await list(companyA, as('OWNER'), '?status=resolved');
    assert.equal(
      (JSON.parse(byOwner.body) as { items: NotificationItem[] }).items[0]?.resolvedByMe,
      false,
    );
    const summary = await app.inject({
      method: 'GET',
      url: `${base(companyA)}/notifications/summary`,
      headers: as('AGENT'),
    });
    assert.deepEqual(JSON.parse(summary.body), { open: 0 });
  });

  it('id malformado ou inexistente é o mesmo 404; query inválida é 400', async () => {
    for (const id of ['nao-e-uuid', randomUUID()]) {
      const response = await app.inject({
        method: 'POST',
        url: `${base(companyA)}/notifications/${id}/resolve`,
        headers: as('OWNER'),
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.body.includes(id), false);
    }
    for (const query of ['?status=x', '?limit=51', '?limit=0', '?extra=1']) {
      const response = await list(companyA, as('OWNER'), query);
      assert.equal(response.statusCode, 400, query);
      assert.equal(errorOf(response.body).code, 'VALIDATION_ERROR');
    }
  });
});
