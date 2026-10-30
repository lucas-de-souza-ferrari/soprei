import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ClientService } from '../../application/clients/client.service.js';
import { type Client, USER_ROLES, type UserRole } from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';

interface Route {
  readonly label: string;
  /** Permissão exigida (para a matriz). */
  readonly permission: 'conversation:read' | 'conversation:simulate';
  request(
    clientId: string,
    conversationId: string,
  ): { method: 'GET' | 'POST'; url: string; payload?: object };
  readonly okStatuses: readonly number[];
}

const ROUTES: readonly Route[] = [
  {
    label: 'GET conversations',
    permission: 'conversation:read',
    request: (clientId) => ({ method: 'GET', url: `/admin/clients/${clientId}/conversations` }),
    okStatuses: [200],
  },
  {
    label: 'GET conversations/:id/messages',
    permission: 'conversation:read',
    request: (clientId, conversationId) => ({
      method: 'GET',
      url: `/admin/clients/${clientId}/conversations/${conversationId}/messages`,
    }),
    okStatuses: [200],
  },
  {
    label: 'POST messages (simulador)',
    permission: 'conversation:simulate',
    request: (clientId) => ({
      method: 'POST',
      url: `/admin/clients/${clientId}/messages`,
      payload: { contactRef: 'c-rbac', text: 'Olá' },
    }),
    okStatuses: [200, 201],
  },
];

const ALLOWED: Record<UserRole, readonly string[]> = {
  OWNER: ['conversation:read', 'conversation:simulate'],
  ADMIN: ['conversation:read', 'conversation:simulate'],
  AGENT: ['conversation:read', 'conversation:simulate'],
  VIEWER: ['conversation:read'],
};

describe('RBAC nas rotas de conversa (spec 008)', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let metrics: Metrics;
  let logs: LogCapture;
  let clientA: Client;
  let clientB: Client;
  let conversationId: string;
  const tokens = new Map<UserRole, { authorization: string }>();
  let ownerB: { authorization: string };
  let platform: { authorization: string };

  before(async () => {
    logs = captureLogs();
    metrics = createMetrics();
    const clients = new InMemoryClientRepository();
    testAuth = buildTestAuth({ logger: logs.logger, clients, metrics });
    const store = new InMemoryAttendanceStore();
    app = buildServer({
      logger: logs.logger,
      metrics,
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      auth: testAuth.service,
      admin: {
        clients: new ClientService(clients),
        attendance: new AttendanceService({
          clients,
          conversations: store.conversations,
          messages: store.messages,
          unitOfWork: store,
          llm: new MockLlmProvider(),
          logger: logs.logger,
          metrics,
          options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000 },
        }),
      },
    });
    await app.ready();
    clientA = await clients.create({ name: 'A', slug: 'cliente-a' });
    clientB = await clients.create({ name: 'B', slug: 'cliente-b' });
    for (const role of USER_ROLES) {
      tokens.set(role, bearer((await testAuth.userToken(clientA.id, { role })).accessToken));
    }
    ownerB = bearer((await testAuth.userToken(clientB.id, { role: 'OWNER' })).accessToken);
    platform = bearer((await testAuth.platformToken()).accessToken);
    // Uma conversa de A, para a rota de mensagens.
    const seeded = await app.inject({
      method: 'POST',
      url: `/admin/clients/${clientA.id}/messages`,
      headers: tokens.get('OWNER') as { authorization: string },
      payload: { contactRef: 'semente', text: 'semente' },
    });
    conversationId = seeded.json<{ conversationId: string }>().conversationId;
  });
  after(async () => {
    await app.close();
  });

  const call = (route: Route, clientId: string, headers?: Record<string, string>) => {
    const request = route.request(clientId, conversationId);
    return app.inject({
      method: request.method,
      url: request.url,
      ...(headers === undefined ? {} : { headers }),
      ...(request.payload === undefined ? {} : { payload: request.payload }),
    });
  };

  for (const route of ROUTES) {
    describe(route.label, () => {
      for (const role of USER_ROLES) {
        const allowed = ALLOWED[role].includes(route.permission);
        it(`${role} ${allowed ? 'passa' : 'leva 403'} (matriz da spec)`, async () => {
          const response = await call(route, clientA.id, tokens.get(role));
          if (allowed) {
            assert.ok(
              route.okStatuses.includes(response.statusCode),
              `status ${String(response.statusCode)}`,
            );
          } else {
            assert.equal(response.statusCode, 403);
            assert.equal(response.json<{ error: { code: string } }>().error.code, 'FORBIDDEN');
          }
        });
      }

      it('sem token 401; PlatformAdmin 403', async () => {
        assert.equal((await call(route, clientA.id)).statusCode, 401);
        assert.equal((await call(route, clientA.id, platform)).statusCode, 403);
      });

      it('404 antes de 403: :clientId alheio ou inexistente dá o MESMO 404, tenha o papel a permissão ou não', async () => {
        const ghost = randomUUID();
        const bodies = new Set<string>();
        for (const role of USER_ROLES) {
          const alien = await call(route, clientB.id, tokens.get(role));
          const missing = await call(route, ghost, tokens.get(role));
          assert.equal(alien.statusCode, 404, `${role} alheio`);
          assert.equal(missing.statusCode, 404, `${role} inexistente`);
          const strip = (body: string): string =>
            body.replace(/"requestId":"[^"]*"/, '"requestId":""');
          bodies.add(strip(alien.body));
          bodies.add(strip(missing.body));
        }
        assert.equal(bodies.size, 1, 'a resposta é idêntica em todos os casos');
      });
    });
  }

  it('o OWNER do cliente B não lê nem escreve no cliente A por :clientId', async () => {
    for (const route of ROUTES) {
      assert.equal((await call(route, clientA.id, ownerB)).statusCode, 404, route.label);
    }
  });

  it('authz_denials_total conta cada negação por permissão, sem id nem e-mail', async () => {
    const before = await metrics.render();
    const count = (text: string, permission: string): number =>
      Number(
        new RegExp(`^authz_denials_total\\{permission="${permission}"\\} (\\d+)$`, 'm').exec(
          text,
        )?.[1] ?? 0,
      );
    const denied = await call(ROUTES[2] as Route, clientA.id, tokens.get('VIEWER'));
    assert.equal(denied.statusCode, 403);
    const after = await metrics.render();
    assert.equal(count(after, 'conversation:simulate'), count(before, 'conversation:simulate') + 1);
    const lines = after.split('\n').filter((line) => line.startsWith('authz_denials_total'));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.match(line, /^authz_denials_total\{permission="[a-z]+:[a-z]+"\} \d+$/);
    }
    assert.ok(!after.includes(clientA.id));
  });

  it('a negação é logada em warn só com padrão de rota, permissão e papel (sem e-mail nem token)', async () => {
    const owner = await testAuth.userToken(clientA.id, { role: 'VIEWER' });
    const response = await app.inject({
      method: 'POST',
      url: `/admin/clients/${clientA.id}/messages`,
      headers: bearer(owner.accessToken),
      payload: { contactRef: 'c', text: 'segredo-da-mensagem' },
    });
    assert.equal(response.statusCode, 403);
    const denial = logs
      .lines()
      .filter((line) => line.msg === 'permissão negada')
      .at(-1);
    assert.ok(denial !== undefined);
    assert.equal(denial.level, 40);
    assert.equal(denial.permission, 'conversation:simulate');
    assert.equal(denial.role, 'VIEWER');
    assert.equal(denial.route, '/admin/clients/:clientId/messages');
    const raw = logs.raw();
    assert.ok(!raw.includes(owner.email));
    assert.ok(!raw.includes(owner.accessToken));
    assert.ok(!raw.includes('segredo-da-mensagem'));
  });
});
