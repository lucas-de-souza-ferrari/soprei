import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClientService } from '../../application/clients/client.service.js';
import { type Client, USER_ROLES, type UserRole } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import {
  bearer,
  buildTestAuth,
  InMemorySessionStore,
  type IssuedLogin,
  type TestAuth,
  TEST_PASSWORD,
} from '../../test-support/in-memory-auth.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}
interface UserBody {
  id: string;
  email: string;
  role: UserRole;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}
interface PageBody {
  items: UserBody[];
  nextCursor: string | null;
}

const NEW_PASSWORD = 'uma-senha-nova-bem-longa-9';
const SECRET_PASSWORD = 'senha-ultra-secreta-do-teste-77';
const SECRET_EMAIL = 'pessoa-secreta-nova@exemplo.test';

interface Env {
  app: FastifyInstance;
  auth: TestAuth;
  logs: LogCapture;
  metrics: Metrics;
  store: InMemorySessionStore;
  clientA: Client;
  clientB: Client;
}

async function setup(): Promise<Env> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const store = new InMemorySessionStore({ maxFailures: 3 });
  const auth = buildTestAuth({ logger: logs.logger, metrics, sessions: store, maxFailures: 3 });
  const app = buildServer({
    logger: logs.logger,
    metrics,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    auth: auth.service,
    userAdmin: auth.userAdmin,
    admin: { clients: new ClientService(auth.clients) },
  });
  await app.ready();
  const clientA = await auth.clients.create({ name: 'Cliente A', slug: 'cliente-a' });
  const clientB = await auth.clients.create({ name: 'Cliente B', slug: 'cliente-b' });
  return { app, auth, logs, metrics, store, clientA, clientB };
}

describe('rotas de usuários (/admin/clients/:clientId/users), spec 008', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.app.close();
  });

  const login = (client: Client, role: UserRole): Promise<IssuedLogin> =>
    env.auth.userToken(client.id, { role });
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    who?: IssuedLogin,
    payload?: object,
  ) =>
    env.app.inject({
      method,
      url,
      ...(who === undefined ? {} : { headers: bearer(who.accessToken) }),
      ...(payload === undefined ? {} : { payload }),
    });
  const base = (client: Client): string => `/admin/clients/${client.id}/users`;
  const errorCode = (response: { body: string }): string =>
    (JSON.parse(response.body) as ErrorBody).error.code;
  const dbUser = (client: Client, id: string) => env.auth.users.findById(client.id, id);

  describe('permissões por papel (tabela da spec)', () => {
    const matrix: readonly {
      label: string;
      allowed: readonly UserRole[];
      run: (target: IssuedLogin, who: IssuedLogin) => Promise<{ statusCode: number }>;
    }[] = [
      {
        label: 'GET /users',
        allowed: ['OWNER', 'ADMIN'],
        run: (_target, who) => call('GET', base(env.clientA), who),
      },
      {
        label: 'POST /users',
        allowed: ['OWNER', 'ADMIN'],
        run: (_target, who) =>
          call('POST', base(env.clientA), who, {
            email: `novo-${randomUUID()}@exemplo.test`,
            password: NEW_PASSWORD,
            role: 'VIEWER',
          }),
      },
      {
        label: 'PATCH /users/:id',
        allowed: ['OWNER', 'ADMIN'],
        run: (target, who) =>
          call('PATCH', `${base(env.clientA)}/${target.userId}`, who, { role: 'AGENT' }),
      },
      {
        label: 'GET /audit-events',
        allowed: ['OWNER', 'ADMIN'],
        run: (_target, who) => call('GET', `/admin/clients/${env.clientA.id}/audit-events`, who),
      },
      {
        label: 'POST /users/:id/password',
        allowed: ['OWNER', 'ADMIN'],
        run: (target, who) =>
          call('POST', `${base(env.clientA)}/${target.userId}/password`, who, {
            newPassword: NEW_PASSWORD,
          }),
      },
    ];
    for (const route of matrix) {
      for (const role of USER_ROLES) {
        const allowed = route.allowed.includes(role);
        it(`${route.label}: ${role} ${allowed ? 'passa' : 'leva 403'}`, async () => {
          const who = await login(env.clientA, role);
          // Alvo gerenciável por qualquer papel que tenha user:manage (AGENT).
          const target = await login(env.clientA, 'VIEWER');
          const response = await route.run(target, who);
          if (allowed)
            assert.ok([200, 201, 204].includes(response.statusCode), String(response.statusCode));
          else assert.equal(response.statusCode, 403);
        });
      }
    }

    it('sem token 401; PlatformAdmin 403; :clientId alheio 404 igual ao inexistente (antes do 403)', async () => {
      const platform = await env.auth.platformToken();
      const viewer = await login(env.clientA, 'VIEWER');
      const owner = await login(env.clientA, 'OWNER');
      assert.equal((await call('GET', base(env.clientA))).statusCode, 401);
      assert.equal((await call('GET', base(env.clientA), platform)).statusCode, 403);
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const seen = new Set<string>();
      for (const who of [viewer, owner]) {
        for (const url of [base(env.clientB), `/admin/clients/${randomUUID()}/users`]) {
          for (const [method, payload] of [
            ['GET', undefined],
            ['POST', { email: 'x@exemplo.test', password: NEW_PASSWORD, role: 'AGENT' }],
          ] as const) {
            const response = await call(method, url, who, payload);
            assert.equal(response.statusCode, 404);
            seen.add(strip(response.body));
          }
        }
      }
      assert.equal(seen.size, 1);
    });
  });

  describe('criar usuário', () => {
    it('OWNER cria qualquer papel; ADMIN cria AGENT/VIEWER e leva 403 em ADMIN/OWNER', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const admin = await login(env.clientA, 'ADMIN');
      for (const role of USER_ROLES) {
        const created = await call('POST', base(env.clientA), owner, {
          email: `o-${randomUUID()}@exemplo.test`,
          password: NEW_PASSWORD,
          role,
        });
        assert.equal(created.statusCode, 201, role);
        assert.equal(created.json<UserBody>().role, role);
      }
      for (const role of USER_ROLES) {
        const result = await call('POST', base(env.clientA), admin, {
          email: `a-${randomUUID()}@exemplo.test`,
          password: NEW_PASSWORD,
          role,
        });
        assert.equal(result.statusCode, role === 'AGENT' || role === 'VIEWER' ? 201 : 403, role);
      }
    });

    it('resposta com id, e-mail, papel, estado e createdAt, sem hash; e-mail normalizado', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const response = await call('POST', base(env.clientA), owner, {
        email: '  Pessoa.NOVA@Exemplo.Test ',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<UserBody>();
      assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'email', 'id', 'role', 'status']);
      assert.equal(body.email, 'pessoa.nova@exemplo.test');
      assert.equal(body.status, 'ACTIVE');
      assert.ok(!/hash|scrypt|fake\$/i.test(response.body));
    });

    it('e-mail repetido no mesmo cliente é 409; o mesmo e-mail em outro cliente funciona', async () => {
      const ownerA = await login(env.clientA, 'OWNER');
      const ownerB = await login(env.clientB, 'OWNER');
      const payload = { email: 'repetido@exemplo.test', password: NEW_PASSWORD, role: 'AGENT' };
      assert.equal((await call('POST', base(env.clientA), ownerA, payload)).statusCode, 201);
      const dup = await call('POST', base(env.clientA), ownerA, payload);
      assert.equal(dup.statusCode, 409);
      assert.equal(errorCode(dup), 'CONFLICT');
      assert.equal((await call('POST', base(env.clientB), ownerB, payload)).statusCode, 201);
    });

    it('senha fora da política e corpo inválido são 400 sem ecoar o valor', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const attempts: object[] = [
        { email: SECRET_EMAIL, password: 'curta', role: 'AGENT' },
        { email: SECRET_EMAIL, password: `${SECRET_PASSWORD}\u0000`, role: 'AGENT' },
        { email: 'nao-e-email-secreto', password: SECRET_PASSWORD, role: 'AGENT' },
        { email: SECRET_EMAIL, password: SECRET_PASSWORD, role: 'ROOT' },
        { email: SECRET_EMAIL, password: SECRET_PASSWORD, role: 'AGENT', extra: SECRET_PASSWORD },
        { email: SECRET_EMAIL, password: SECRET_PASSWORD },
      ];
      for (const payload of attempts) {
        const response = await call('POST', base(env.clientA), owner, payload);
        assert.equal(response.statusCode, 400);
        assert.ok(!response.body.includes(SECRET_PASSWORD));
        assert.ok(!response.body.includes(SECRET_EMAIL));
        assert.ok(!response.body.includes('nao-e-email-secreto'));
      }
      assert.ok(!env.logs.raw().includes(SECRET_PASSWORD));
      assert.ok(!env.logs.raw().includes(SECRET_EMAIL));
    });

    it('o ClientId é o do token: o usuário criado nasce no cliente do ator', async () => {
      const ownerA = await login(env.clientA, 'OWNER');
      const created = await call('POST', base(env.clientA), ownerA, {
        email: 'no-a@exemplo.test',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(
        (await dbUser(env.clientA, created.json<UserBody>().id)).clientId,
        env.clientA.id,
      );
      await assert.rejects(dbUser(env.clientB, created.json<UserBody>().id));
    });
  });

  describe('listar usuários', () => {
    it('só os do cliente do token, paginado por cursor, sem hash', async () => {
      const owner = await login(env.clientA, 'OWNER');
      for (let i = 0; i < 4; i += 1) await login(env.clientA, 'AGENT');
      await login(env.clientB, 'OWNER');
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await call(
          'GET',
          `${base(env.clientA)}?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
          owner,
        );
        assert.equal(response.statusCode, 200);
        const page = response.json<PageBody>();
        seen.push(...page.items.map((item) => item.id));
        for (const item of page.items) {
          assert.deepEqual(Object.keys(item).sort(), [
            'createdAt',
            'email',
            'id',
            'role',
            'status',
          ]);
        }
        assert.ok(!/hash|fake\$/i.test(response.body));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 5);
      assert.ok(await Promise.all(seen.map((id) => dbUser(env.clientA, id))));
    });
  });

  describe('hierarquia', () => {
    it('ADMIN não altera, desativa nem redefine a senha de OWNER ou de outro ADMIN (403) e não promove a ADMIN/OWNER', async () => {
      const admin = await login(env.clientA, 'ADMIN');
      const owner = await login(env.clientA, 'OWNER');
      const otherAdmin = await login(env.clientA, 'ADMIN');
      const agent = await login(env.clientA, 'AGENT');
      for (const target of [owner, otherAdmin]) {
        const url = `${base(env.clientA)}/${target.userId}`;
        assert.equal((await call('PATCH', url, admin, { role: 'AGENT' })).statusCode, 403);
        assert.equal((await call('PATCH', url, admin, { status: 'DISABLED' })).statusCode, 403);
        assert.equal(
          (await call('POST', `${url}/password`, admin, { newPassword: NEW_PASSWORD })).statusCode,
          403,
        );
      }
      for (const role of ['ADMIN', 'OWNER'] as const) {
        assert.equal(
          (await call('PATCH', `${base(env.clientA)}/${agent.userId}`, admin, { role })).statusCode,
          403,
        );
      }
      // O banco continua intacto.
      assert.equal((await dbUser(env.clientA, owner.userId)).role, 'OWNER');
      assert.equal((await dbUser(env.clientA, otherAdmin.userId)).role, 'ADMIN');
      assert.equal((await dbUser(env.clientA, agent.userId)).role, 'AGENT');
      // E o que é permitido funciona: AGENT <-> VIEWER.
      const ok = await call('PATCH', `${base(env.clientA)}/${agent.userId}`, admin, {
        role: 'VIEWER',
      });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json<UserBody>().role, 'VIEWER');
    });

    it('OWNER altera, desativa, redefine a senha e promove a qualquer papel', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const admin = await login(env.clientA, 'ADMIN');
      const agent = await login(env.clientA, 'AGENT');
      const url = (u: IssuedLogin): string => `${base(env.clientA)}/${u.userId}`;
      assert.equal((await call('PATCH', url(agent), owner, { role: 'ADMIN' })).statusCode, 200);
      assert.equal((await call('PATCH', url(agent), owner, { role: 'OWNER' })).statusCode, 200);
      assert.equal((await call('PATCH', url(admin), owner, { role: 'VIEWER' })).statusCode, 200);
      assert.equal(
        (await call('PATCH', url(admin), owner, { status: 'DISABLED' })).statusCode,
        200,
      );
      assert.equal(
        (await call('POST', `${url(admin)}/password`, owner, { newPassword: NEW_PASSWORD }))
          .statusCode,
        204,
      );
      assert.equal((await dbUser(env.clientA, agent.userId)).role, 'OWNER');
      assert.equal((await dbUser(env.clientA, admin.userId)).status, 'DISABLED');
    });

    it('ninguém altera o próprio papel nem o próprio estado, nem a própria senha por aqui (403)', async () => {
      for (const role of USER_ROLES.filter((r) => r === 'OWNER' || r === 'ADMIN')) {
        const me = await login(env.clientA, role);
        // Um segundo OWNER, para provar que não é a regra do último OWNER que barra.
        await login(env.clientA, 'OWNER');
        const url = `${base(env.clientA)}/${me.userId}`;
        for (const patch of [
          { role: 'OWNER' },
          { role: 'AGENT' },
          { role },
          { status: 'DISABLED' },
          { status: 'ACTIVE' },
        ]) {
          const response = await call('PATCH', url, me, patch);
          assert.equal(response.statusCode, 403, `${role} ${JSON.stringify(patch)}`);
        }
        assert.equal(
          (await call('POST', `${url}/password`, me, { newPassword: NEW_PASSWORD })).statusCode,
          403,
        );
        assert.equal((await dbUser(env.clientA, me.userId)).role, role);
        assert.equal((await dbUser(env.clientA, me.userId)).status, 'ACTIVE');
      }
    });

    it('auto-promoção: AGENT e ADMIN pedindo OWNER para si levam 403 e o banco fica intacto', async () => {
      const agent = await login(env.clientA, 'AGENT');
      const admin = await login(env.clientA, 'ADMIN');
      assert.equal(
        (await call('PATCH', `${base(env.clientA)}/${agent.userId}`, agent, { role: 'OWNER' }))
          .statusCode,
        403,
      );
      assert.equal(
        (await call('PATCH', `${base(env.clientA)}/${admin.userId}`, admin, { role: 'OWNER' }))
          .statusCode,
        403,
      );
      assert.equal((await dbUser(env.clientA, agent.userId)).role, 'AGENT');
      assert.equal((await dbUser(env.clientA, admin.userId)).role, 'ADMIN');
      assert.equal(env.auth.audit.events.length, 0);
    });
  });

  describe('último OWNER', () => {
    it('com dois OWNER, um rebaixa o outro; o único que sobra não pode ser tocado por ninguém (nada muda)', async () => {
      const first = await login(env.clientA, 'OWNER');
      const second = await login(env.clientA, 'OWNER');
      const admin = await login(env.clientA, 'ADMIN');
      const down = await call('PATCH', `${base(env.clientA)}/${first.userId}`, second, {
        role: 'ADMIN',
      });
      assert.equal(down.statusCode, 200);
      assert.equal(await env.auth.users.countActiveOwners(env.clientA.id), 1);
      const sole = `${base(env.clientA)}/${second.userId}`;
      // O sobrante não se altera (403, ninguém altera a si mesmo), o ADMIN não o alcança (403) e
      // o OWNER rebaixado, mesmo com o token antigo, age com o papel do banco (403).
      for (const who of [second, admin]) {
        for (const patch of [{ role: 'AGENT' }, { status: 'DISABLED' }]) {
          assert.equal((await call('PATCH', sole, who, patch)).statusCode, 403);
        }
      }
      // O rebaixado perdeu as sessões (a revogação vem depois do commit): o token antigo é 401.
      assert.equal((await call('PATCH', sole, first, { role: 'AGENT' })).statusCode, 401);
      assert.equal((await dbUser(env.clientA, second.userId)).role, 'OWNER');
      assert.equal((await dbUser(env.clientA, second.userId)).status, 'ACTIVE');
      assert.equal(await env.auth.users.countActiveOwners(env.clientA.id), 1);
    });

    it('OWNER desativado não conta como OWNER ativo; reativar não é bloqueado e volta a contar', async () => {
      const actor = await login(env.clientA, 'OWNER');
      const other = await login(env.clientA, 'OWNER');
      const third = await login(env.clientA, 'OWNER');
      assert.equal(await env.auth.users.countActiveOwners(env.clientA.id), 3);
      const disable = await call('PATCH', `${base(env.clientA)}/${other.userId}`, actor, {
        status: 'DISABLED',
      });
      assert.equal(disable.statusCode, 200);
      assert.equal(await env.auth.users.countActiveOwners(env.clientA.id), 2);
      const demote = await call('PATCH', `${base(env.clientA)}/${third.userId}`, actor, {
        role: 'AGENT',
      });
      assert.equal(demote.statusCode, 200);
      assert.equal(await env.auth.users.countActiveOwners(env.clientA.id), 1);
      const enable = await call('PATCH', `${base(env.clientA)}/${other.userId}`, actor, {
        status: 'ACTIVE',
      });
      assert.equal(enable.statusCode, 200);
      assert.equal(await env.auth.users.countActiveOwners(env.clientA.id), 2);
    });
  });

  describe('PATCH sem efeito e inválido', () => {
    it('papel e estado iguais ao atual: 200 sem auditoria; PATCH vazio ou com campo estranho é 400', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const agent = await login(env.clientA, 'AGENT');
      const url = `${base(env.clientA)}/${agent.userId}`;
      const same = await call('PATCH', url, owner, { role: 'AGENT', status: 'ACTIVE' });
      assert.equal(same.statusCode, 200);
      assert.equal(env.auth.audit.events.length, 0);
      for (const payload of [{}, { email: 'x@exemplo.test' }, { role: 'AGENT', extra: 1 }]) {
        assert.equal((await call('PATCH', url, owner, payload)).statusCode, 400);
      }
      assert.equal(env.auth.audit.events.length, 0);
    });

    it(':userId que não é UUID, inexistente ou de outro cliente: o mesmo 404', async () => {
      const ownerA = await login(env.clientA, 'OWNER');
      const userB = await login(env.clientB, 'AGENT');
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const seen = new Set<string>();
      for (const id of ['nao-e-uuid', randomUUID(), userB.userId]) {
        for (const suffix of ['', '/password']) {
          const method = suffix === '' ? 'PATCH' : 'POST';
          const payload = suffix === '' ? { role: 'VIEWER' } : { newPassword: NEW_PASSWORD };
          const response = await call(
            method,
            `${base(env.clientA)}/${id}${suffix}`,
            ownerA,
            payload,
          );
          assert.equal(response.statusCode, 404, `${id}${suffix}`);
          seen.add(strip(response.body));
        }
      }
      assert.equal(seen.size, 1);
      assert.equal((await dbUser(env.clientB, userB.userId)).role, 'AGENT');
    });
  });

  describe('efeito imediato nas sessões', () => {
    for (const scenario of [
      {
        label: 'mudar o papel',
        act: (owner: IssuedLogin, target: IssuedLogin) =>
          call('PATCH', `${base(env.clientA)}/${target.userId}`, owner, { role: 'VIEWER' }),
      },
      {
        label: 'desativar',
        act: (owner: IssuedLogin, target: IssuedLogin) =>
          call('PATCH', `${base(env.clientA)}/${target.userId}`, owner, { status: 'DISABLED' }),
      },
      {
        label: 'redefinir a senha',
        act: (owner: IssuedLogin, target: IssuedLogin) =>
          call('POST', `${base(env.clientA)}/${target.userId}/password`, owner, {
            newPassword: NEW_PASSWORD,
          }),
      },
    ]) {
      it(`depois de ${scenario.label}, o access token ainda válido do alvo é recusado e o refresh falha; outros não são afetados`, async () => {
        const owner = await login(env.clientA, 'OWNER');
        const target = await login(env.clientA, 'AGENT');
        const bystander = await login(env.clientA, 'AGENT');
        const otherClient = await login(env.clientB, 'AGENT');
        // O alvo está autenticado antes.
        assert.equal((await call('GET', '/auth/me', target)).statusCode, 200);
        const response = await scenario.act(owner, target);
        assert.ok([200, 204].includes(response.statusCode));
        // `nbf` tem precisão de segundos e o relógio é o real: o token do alvo foi emitido no
        // mesmo segundo, então o store em memória o derruba pela sessão revogada.
        const after = await call('GET', '/auth/me', target);
        assert.equal(after.statusCode, 401);
        const refresh = await env.app.inject({
          method: 'POST',
          url: '/auth/refresh',
          payload: { refreshToken: target.refreshToken },
        });
        assert.equal(refresh.statusCode, 401);
        // Outras pessoas (mesmo cliente e outro cliente) seguem autenticadas.
        for (const who of [bystander, owner, otherClient]) {
          assert.equal((await call('GET', '/auth/me', who)).statusCode, 200);
        }
      });
    }

    it('depois de mudar o papel, o login traz o papel novo; desativado não loga; senha nova vale e a antiga não', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const target = await login(env.clientA, 'AGENT');
      await call('PATCH', `${base(env.clientA)}/${target.userId}`, owner, { role: 'VIEWER' });
      const relogin = await env.auth.service.login({
        clientSlug: env.clientA.slug,
        email: target.email,
        password: TEST_PASSWORD,
      });
      assert.ok(relogin.ok);
      const identity = await env.auth.service.authenticate(relogin.value.accessToken);
      assert.ok(identity.ok && identity.value.kind === 'user' && identity.value.role === 'VIEWER');

      await call('POST', `${base(env.clientA)}/${target.userId}/password`, owner, {
        newPassword: NEW_PASSWORD,
      });
      assert.ok(
        !(
          await env.auth.service.login({
            clientSlug: env.clientA.slug,
            email: target.email,
            password: TEST_PASSWORD,
          })
        ).ok,
      );
      assert.ok(
        (
          await env.auth.service.login({
            clientSlug: env.clientA.slug,
            email: target.email,
            password: NEW_PASSWORD,
          })
        ).ok,
      );

      await call('PATCH', `${base(env.clientA)}/${target.userId}`, owner, { status: 'DISABLED' });
      assert.ok(
        !(
          await env.auth.service.login({
            clientSlug: env.clientA.slug,
            email: target.email,
            password: NEW_PASSWORD,
          })
        ).ok,
      );
    });

    it('reativar não revoga as sessões do alvo', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const target = await login(env.clientA, 'AGENT');
      await env.auth.users.update(env.clientA.id, target.userId, { status: 'DISABLED' });
      const response = await call('PATCH', `${base(env.clientA)}/${target.userId}`, owner, {
        status: 'ACTIVE',
      });
      assert.equal(response.statusCode, 200);
      assert.equal((await call('GET', '/auth/me', target)).statusCode, 200);
    });

    it('Redis fora DEPOIS do commit: 503, a mudança e a auditoria ficam gravadas e repetir o PATCH refaz a revogação', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const target = await login(env.clientA, 'AGENT');
      env.store.failRevokeAllWith = new ServiceUnavailableError('redis fora');
      const url = `${base(env.clientA)}/${target.userId}`;
      const first = await call('PATCH', url, owner, { role: 'VIEWER' });
      assert.equal(first.statusCode, 503);
      assert.equal(errorCode(first), 'SERVICE_UNAVAILABLE');
      assert.equal((await dbUser(env.clientA, target.userId)).role, 'VIEWER');
      assert.equal(env.auth.audit.events.length, 1);
      // O token do alvo ainda vale (a revogação não aconteceu)...
      assert.equal((await call('GET', '/auth/me', target)).statusCode, 200);
      // ...repetir o pedido (já aplicado: sem efeito, sem auditoria nova) refaz a revogação.
      env.store.failRevokeAllWith = undefined;
      const again = await call('PATCH', url, owner, { role: 'VIEWER' });
      assert.equal(again.statusCode, 200);
      assert.equal(env.auth.audit.events.length, 1, 'repetir não duplica a auditoria');
      assert.equal((await call('GET', '/auth/me', target)).statusCode, 401);
    });

    it('o ator rebaixado cujo token ainda vale (revogação falhou) não age mais: o papel é relido do banco', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const admin = await login(env.clientA, 'ADMIN');
      env.store.failRevokeAllWith = new ServiceUnavailableError('redis fora');
      const demote = await call('PATCH', `${base(env.clientA)}/${admin.userId}`, owner, {
        role: 'AGENT',
      });
      assert.equal(demote.statusCode, 503);
      // O token do ex-ADMIN ainda é aceito pelo hook e o claim diz ADMIN; o service o recusa.
      const create = await call('POST', base(env.clientA), admin, {
        email: 'escalada@exemplo.test',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(create.statusCode, 403);
      assert.equal(
        await env.auth.users.findCredentialsByEmail(env.clientA.id, 'escalada@exemplo.test'),
        null,
      );
    });
  });

  describe('auditoria e privacidade', () => {
    it('cada operação grava um evento com ator, alvo, ação e papéis; reativar e desativar são ações distintas', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const created = (
        await call('POST', base(env.clientA), owner, {
          email: 'auditado@exemplo.test',
          password: NEW_PASSWORD,
          role: 'AGENT',
        })
      ).json<UserBody>();
      const url = `${base(env.clientA)}/${created.id}`;
      await call('PATCH', url, owner, { role: 'ADMIN' });
      await call('PATCH', url, owner, { status: 'DISABLED' });
      await call('PATCH', url, owner, { status: 'ACTIVE' });
      await call('POST', `${url}/password`, owner, { newPassword: NEW_PASSWORD });
      const events = env.auth.audit.events;
      assert.deepEqual(
        events.map((event) => event.action),
        [
          'USER_CREATED',
          'USER_ROLE_CHANGED',
          'USER_DISABLED',
          'USER_ENABLED',
          'USER_PASSWORD_RESET',
        ],
      );
      for (const event of events) {
        assert.equal(event.actorUserId, owner.userId);
        assert.equal(event.targetUserId, created.id);
        assert.equal(event.clientId, env.clientA.id);
      }
      const [createdEvent, roleEvent, disabledEvent] = events;
      assert.ok(createdEvent && roleEvent && disabledEvent);
      assert.equal(createdEvent.toRole, 'AGENT');
      assert.equal(createdEvent.fromRole, null);
      assert.equal(roleEvent.fromRole, 'AGENT');
      assert.equal(roleEvent.toRole, 'ADMIN');
      assert.equal(disabledEvent.fromRole, null);
    });

    it('papel e estado juntos no mesmo PATCH geram dois eventos', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const agent = await login(env.clientA, 'AGENT');
      await call('PATCH', `${base(env.clientA)}/${agent.userId}`, owner, {
        role: 'VIEWER',
        status: 'DISABLED',
      });
      assert.deepEqual(
        env.auth.audit.events.map((event) => event.action),
        ['USER_ROLE_CHANGED', 'USER_DISABLED'],
      );
    });

    it('falha ao gravar a trilha desfaz a mudança do usuário (mesma transação) e não revoga sessão', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const agent = await login(env.clientA, 'AGENT');
      env.auth.audit.failWith = new Error('falha de teste na trilha');
      const response = await call('PATCH', `${base(env.clientA)}/${agent.userId}`, owner, {
        role: 'VIEWER',
      });
      assert.equal(response.statusCode, 500);
      env.auth.audit.failWith = undefined;
      assert.equal((await dbUser(env.clientA, agent.userId)).role, 'AGENT');
      assert.equal(env.auth.audit.events.length, 0);
      assert.equal((await call('GET', '/auth/me', agent)).statusCode, 200);
      // Criar com a trilha falhando também não deixa o usuário.
      env.auth.audit.failWith = new Error('falha de teste na trilha');
      const created = await call('POST', base(env.clientA), owner, {
        email: 'fantasma@exemplo.test',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(created.statusCode, 500);
      assert.equal(
        await env.auth.users.findCredentialsByEmail(env.clientA.id, 'fantasma@exemplo.test'),
        null,
      );
    });

    it('o log audit traz só ids e enum; e-mail, senha, hash e tokens secretos não aparecem em log, métrica nem erro', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const secretEmail = 'segredo-total@exemplo.test';
      const bodies: string[] = [];
      const created = await call('POST', base(env.clientA), owner, {
        email: secretEmail,
        password: SECRET_PASSWORD,
        role: 'AGENT',
      });
      // (a resposta de sucesso devolve o e-mail a quem o criou: só as de ERRO entram na conferência)
      const id = created.json<UserBody>().id;
      for (const response of [
        await call('PATCH', `${base(env.clientA)}/${id}`, owner, { role: 'VIEWER' }),
        await call('POST', `${base(env.clientA)}/${id}/password`, owner, {
          newPassword: SECRET_PASSWORD,
        }),
        await call('POST', `${base(env.clientA)}/${id}/password`, owner, { newPassword: 'x' }),
        await call('POST', base(env.clientA), owner, {
          email: secretEmail,
          password: SECRET_PASSWORD,
          role: 'AGENT',
        }),
      ]) {
        if (response.statusCode >= 400) bodies.push(response.body);
      }
      const audits = env.logs.lines().filter((line) => line.msg === 'audit');
      assert.ok(audits.length >= 3);
      for (const line of audits) {
        assert.deepEqual(
          Object.keys(line)
            .filter(
              (key) =>
                ![
                  'level',
                  'time',
                  'pid',
                  'hostname',
                  'msg',
                  'requestId',
                  'userId',
                  'operation',
                ].includes(key),
            )
            .sort(),
          ['action', 'actorUserId', 'clientId', 'event', 'fromRole', 'targetUserId', 'toRole'],
        );
      }
      const everything = `${env.logs.raw()}\n${await env.metrics.render()}\n${bodies.join('\n')}`;
      for (const secret of [
        SECRET_PASSWORD,
        secretEmail,
        owner.accessToken,
        owner.refreshToken,
        'fake$',
      ]) {
        assert.ok(!everything.includes(secret), `vazou: ${secret.slice(0, 8)}`);
      }
    });

    it('user_admin_actions_total conta por ação, sem id nem e-mail', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const created = (
        await call('POST', base(env.clientA), owner, {
          email: 'metrica@exemplo.test',
          password: NEW_PASSWORD,
          role: 'AGENT',
        })
      ).json<UserBody>();
      await call('PATCH', `${base(env.clientA)}/${created.id}`, owner, { role: 'VIEWER' });
      const text = await env.metrics.render();
      assert.match(text, /user_admin_actions_total\{action="USER_CREATED"\} 1/);
      assert.match(text, /user_admin_actions_total\{action="USER_ROLE_CHANGED"\} 1/);
      assert.ok(!text.includes(created.id) && !text.includes('metrica@'));
    });
  });

  describe('isolamento entre clientes (ponta a ponta com dois clientes)', () => {
    it('OWNER de A com o clientId de B ou o userId de um usuário de B recebe 404 idêntico ao de inexistente; nada de B é lido nem alterado', async () => {
      const ownerA = await login(env.clientA, 'OWNER');
      const ownerB = await login(env.clientB, 'OWNER');
      const victim = await login(env.clientB, 'AGENT');
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const attempts: readonly [string, string, object?][] = [
        ['GET', `/admin/clients/${env.clientB.id}/users`],
        [
          'POST',
          `/admin/clients/${env.clientB.id}/users`,
          { email: 'x@exemplo.test', password: NEW_PASSWORD, role: 'AGENT' },
        ],
        ['PATCH', `/admin/clients/${env.clientB.id}/users/${victim.userId}`, { role: 'VIEWER' }],
        [
          'POST',
          `/admin/clients/${env.clientB.id}/users/${victim.userId}/password`,
          { newPassword: NEW_PASSWORD },
        ],
        ['PATCH', `${base(env.clientA)}/${victim.userId}`, { role: 'VIEWER' }],
        ['POST', `${base(env.clientA)}/${victim.userId}/password`, { newPassword: NEW_PASSWORD }],
      ];
      // Cada tentativa é comparada com o seu equivalente "inexistente": :clientId alheio = cliente
      // inexistente; userId de outro cliente = usuário inexistente.
      const ghostClient = randomUUID();
      const ghostUser = randomUUID();
      const clientBodies = new Set<string>();
      const userBodies = new Set<string>();
      for (const [method, url, payload] of attempts) {
        const response = await call(method as 'GET', url, ownerA, payload);
        assert.equal(response.statusCode, 404, `${method} ${url}`);
        (url.includes(`/clients/${env.clientB.id}/`) ? clientBodies : userBodies).add(
          strip(response.body),
        );
      }
      const ghostClientResponse = await call('GET', `/admin/clients/${ghostClient}/users`, ownerA);
      const ghostUserResponse = await call('PATCH', `${base(env.clientA)}/${ghostUser}`, ownerA, {
        role: 'VIEWER',
      });
      assert.deepEqual([...clientBodies], [strip(ghostClientResponse.body)]);
      assert.deepEqual([...userBodies], [strip(ghostUserResponse.body)]);
      assert.equal((await dbUser(env.clientB, victim.userId)).role, 'AGENT');
      assert.equal(await env.auth.users.countActiveOwners(env.clientB.id), 1);
      assert.equal(env.auth.audit.events.length, 0);
      // O OWNER de B segue com acesso ao que é dele.
      assert.equal((await call('GET', base(env.clientB), ownerB)).statusCode, 200);
    });
  });

  describe('GET /audit-events', () => {
    const auditUrl = (client: Client): string => `/admin/clients/${client.id}/audit-events`;
    interface AuditBody {
      items: {
        id: string;
        action: string;
        actorUserId: string;
        targetUserId: string;
        fromRole: UserRole | null;
        toRole: UserRole | null;
        createdAt: string;
      }[];
      nextCursor: string | null;
    }

    it('só os eventos do cliente do token, mais recentes primeiro, só ids e enum (sem e-mail)', async () => {
      const ownerA = await login(env.clientA, 'OWNER');
      const ownerB = await login(env.clientB, 'OWNER');
      const agent = await login(env.clientA, 'AGENT');
      const agentB = await login(env.clientB, 'AGENT');
      await call('PATCH', `${base(env.clientA)}/${agent.userId}`, ownerA, { role: 'VIEWER' });
      await call('PATCH', `${base(env.clientA)}/${agent.userId}`, ownerA, { status: 'DISABLED' });
      await call('PATCH', `${base(env.clientB)}/${agentB.userId}`, ownerB, { role: 'ADMIN' });
      const response = await call('GET', auditUrl(env.clientA), ownerA);
      assert.equal(response.statusCode, 200);
      const body = response.json<AuditBody>();
      assert.deepEqual(
        body.items.map((item) => item.action),
        ['USER_DISABLED', 'USER_ROLE_CHANGED'],
      );
      assert.deepEqual(Object.keys(body.items[0] ?? {}).sort(), [
        'action',
        'actorUserId',
        'createdAt',
        'fromRole',
        'id',
        'targetUserId',
        'toRole',
      ]);
      assert.ok(body.items.every((item) => item.targetUserId === agent.userId));
      assert.ok(!response.body.includes(ownerA.email) && !response.body.includes(agent.email));
      // O cliente B enxerga só o dele.
      const bodyB = (await call('GET', auditUrl(env.clientB), ownerB)).json<AuditBody>();
      assert.deepEqual(
        bodyB.items.map((item) => item.targetUserId),
        [agentB.userId],
      );
    });

    it('pagina por cursor sem repetir nem perder evento', async () => {
      const owner = await login(env.clientA, 'OWNER');
      const agent = await login(env.clientA, 'AGENT');
      for (const role of ['VIEWER', 'ADMIN', 'VIEWER', 'ADMIN', 'AGENT'] as const) {
        await call('PATCH', `${base(env.clientA)}/${agent.userId}`, owner, { role });
        // O refresh do alvo fica inválido, mas o ator (OWNER) segue autenticado.
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await call(
          'GET',
          `${auditUrl(env.clientA)}?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
          owner,
        );
        const page = response.json<AuditBody>();
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 5);
      assert.deepEqual(seen, env.auth.audit.events.map((event) => event.id).reverse());
    });

    it('sem token 401; PlatformAdmin 403; :clientId alheio 404 igual ao inexistente', async () => {
      const ownerA = await login(env.clientA, 'OWNER');
      const platform = await env.auth.platformToken();
      assert.equal((await call('GET', auditUrl(env.clientA))).statusCode, 401);
      assert.equal((await call('GET', auditUrl(env.clientA), platform)).statusCode, 403);
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const alien = await call('GET', auditUrl(env.clientB), ownerA);
      const ghost = await call('GET', `/admin/clients/${randomUUID()}/audit-events`, ownerA);
      assert.equal(alien.statusCode, 404);
      assert.equal(strip(alien.body), strip(ghost.body));
    });

    it('a trilha é só leitura pela API: não há rota de escrita nem de remoção', async () => {
      const owner = await login(env.clientA, 'OWNER');
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
        const response = await env.app.inject({
          method,
          url: auditUrl(env.clientA),
          headers: bearer(owner.accessToken),
          payload: {},
        });
        assert.equal(response.statusCode, 404, method);
      }
    });
  });
});
