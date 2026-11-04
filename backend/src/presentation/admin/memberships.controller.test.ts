import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import { type Company, MEMBERSHIP_ROLES, type MembershipRole } from '../../domain/index.js';
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
interface MembershipBody {
  id: string;
  email: string;
  role: MembershipRole;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}
interface PageBody {
  items: MembershipBody[];
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
  companyA: Company;
  companyB: Company;
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
    membershipAdmin: auth.membershipAdmin,
    admin: { companies: new CompanyService(auth.companies) },
  });
  await app.ready();
  const companyA = await auth.companies.create({ name: 'Empresa A', slug: 'empresa-a' });
  const companyB = await auth.companies.create({ name: 'Empresa B', slug: 'empresa-b' });
  return { app, auth, logs, metrics, store, companyA, companyB };
}

describe('rotas de usuários (/admin/companies/:companyId/memberships), spec 008', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.app.close();
  });

  const login = (company: Company, role: MembershipRole): Promise<IssuedLogin> =>
    env.auth.membershipToken(company.id, { role });
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
  const base = (company: Company): string => `/admin/companies/${company.id}/memberships`;
  const errorCode = (response: { body: string }): string =>
    (JSON.parse(response.body) as ErrorBody).error.code;
  const dbMembership = (company: Company, id: string) =>
    env.auth.memberships.findById(company.id, id);

  describe('permissões por papel (tabela da spec)', () => {
    const matrix: readonly {
      label: string;
      allowed: readonly MembershipRole[];
      run: (target: IssuedLogin, who: IssuedLogin) => Promise<{ statusCode: number }>;
    }[] = [
      {
        label: 'GET /memberships',
        allowed: ['OWNER', 'ADMIN'],
        run: (_target, who) => call('GET', base(env.companyA), who),
      },
      {
        label: 'POST /memberships',
        allowed: ['OWNER', 'ADMIN'],
        run: (_target, who) =>
          call('POST', base(env.companyA), who, {
            email: `novo-${randomUUID()}@exemplo.test`,
            password: NEW_PASSWORD,
            role: 'VIEWER',
          }),
      },
      {
        label: 'PATCH /memberships/:id',
        allowed: ['OWNER', 'ADMIN'],
        run: (target, who) =>
          call('PATCH', `${base(env.companyA)}/${target.membershipId}`, who, { role: 'AGENT' }),
      },
      {
        label: 'GET /audit-events',
        allowed: ['OWNER', 'ADMIN'],
        run: (_target, who) => call('GET', `/admin/companies/${env.companyA.id}/audit-events`, who),
      },
      {
        label: 'POST /memberships/:id/password',
        allowed: ['OWNER', 'ADMIN'],
        run: (target, who) =>
          call('POST', `${base(env.companyA)}/${target.membershipId}/password`, who, {
            newPassword: NEW_PASSWORD,
          }),
      },
    ];
    for (const route of matrix) {
      for (const role of MEMBERSHIP_ROLES) {
        const allowed = route.allowed.includes(role);
        it(`${route.label}: ${role} ${allowed ? 'passa' : 'leva 403'}`, async () => {
          const who = await login(env.companyA, role);
          // Alvo gerenciável por qualquer papel que tenha membership:manage (AGENT).
          const target = await login(env.companyA, 'VIEWER');
          const response = await route.run(target, who);
          if (allowed)
            assert.ok([200, 201, 204].includes(response.statusCode), String(response.statusCode));
          else assert.equal(response.statusCode, 403);
        });
      }
    }

    it('sem token 401; PlatformAdmin 403; :companyId alheio 404 igual ao inexistente (antes do 403)', async () => {
      const platform = await env.auth.platformToken();
      const viewer = await login(env.companyA, 'VIEWER');
      const owner = await login(env.companyA, 'OWNER');
      assert.equal((await call('GET', base(env.companyA))).statusCode, 401);
      assert.equal((await call('GET', base(env.companyA), platform)).statusCode, 403);
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const seen = new Set<string>();
      for (const who of [viewer, owner]) {
        for (const url of [base(env.companyB), `/admin/companies/${randomUUID()}/memberships`]) {
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
      const owner = await login(env.companyA, 'OWNER');
      const admin = await login(env.companyA, 'ADMIN');
      for (const role of MEMBERSHIP_ROLES) {
        const created = await call('POST', base(env.companyA), owner, {
          email: `o-${randomUUID()}@exemplo.test`,
          password: NEW_PASSWORD,
          role,
        });
        assert.equal(created.statusCode, 201, role);
        assert.equal(created.json<MembershipBody>().role, role);
      }
      for (const role of MEMBERSHIP_ROLES) {
        const result = await call('POST', base(env.companyA), admin, {
          email: `a-${randomUUID()}@exemplo.test`,
          password: NEW_PASSWORD,
          role,
        });
        assert.equal(result.statusCode, role === 'AGENT' || role === 'VIEWER' ? 201 : 403, role);
      }
    });

    it('resposta com id, e-mail, papel, estado e createdAt, sem hash; e-mail normalizado', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const response = await call('POST', base(env.companyA), owner, {
        email: '  Pessoa.NOVA@Exemplo.Test ',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<MembershipBody>();
      assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'email', 'id', 'role', 'status']);
      assert.equal(body.email, 'pessoa.nova@exemplo.test');
      assert.equal(body.status, 'ACTIVE');
      assert.ok(!/hash|scrypt|fake\$/i.test(response.body));
    });

    it('e-mail repetido no mesma empresa é 409; o mesmo e-mail em outra empresa funciona', async () => {
      const ownerA = await login(env.companyA, 'OWNER');
      const ownerB = await login(env.companyB, 'OWNER');
      const payload = { email: 'repetido@exemplo.test', password: NEW_PASSWORD, role: 'AGENT' };
      assert.equal((await call('POST', base(env.companyA), ownerA, payload)).statusCode, 201);
      const dup = await call('POST', base(env.companyA), ownerA, payload);
      assert.equal(dup.statusCode, 409);
      assert.equal(errorCode(dup), 'CONFLICT');
      assert.equal((await call('POST', base(env.companyB), ownerB, payload)).statusCode, 201);
    });

    it('senha fora da política e corpo inválido são 400 sem ecoar o valor', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const attempts: object[] = [
        { email: SECRET_EMAIL, password: 'curta', role: 'AGENT' },
        { email: SECRET_EMAIL, password: `${SECRET_PASSWORD}\u0000`, role: 'AGENT' },
        { email: 'nao-e-email-secreto', password: SECRET_PASSWORD, role: 'AGENT' },
        { email: SECRET_EMAIL, password: SECRET_PASSWORD, role: 'ROOT' },
        { email: SECRET_EMAIL, password: SECRET_PASSWORD, role: 'AGENT', extra: SECRET_PASSWORD },
        { email: SECRET_EMAIL, password: SECRET_PASSWORD },
      ];
      for (const payload of attempts) {
        const response = await call('POST', base(env.companyA), owner, payload);
        assert.equal(response.statusCode, 400);
        assert.ok(!response.body.includes(SECRET_PASSWORD));
        assert.ok(!response.body.includes(SECRET_EMAIL));
        assert.ok(!response.body.includes('nao-e-email-secreto'));
      }
      assert.ok(!env.logs.raw().includes(SECRET_PASSWORD));
      assert.ok(!env.logs.raw().includes(SECRET_EMAIL));
    });

    it('o CompanyId é o do token: o usuário criado nasce na empresa do ator', async () => {
      const ownerA = await login(env.companyA, 'OWNER');
      const created = await call('POST', base(env.companyA), ownerA, {
        email: 'no-a@exemplo.test',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(
        (await dbMembership(env.companyA, created.json<MembershipBody>().id)).companyId,
        env.companyA.id,
      );
      await assert.rejects(dbMembership(env.companyB, created.json<MembershipBody>().id));
    });
  });

  describe('listar usuários', () => {
    it('só os da empresa do token, paginado por cursor, sem hash', async () => {
      const owner = await login(env.companyA, 'OWNER');
      for (let i = 0; i < 4; i += 1) await login(env.companyA, 'AGENT');
      await login(env.companyB, 'OWNER');
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await call(
          'GET',
          `${base(env.companyA)}?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
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
      assert.ok(await Promise.all(seen.map((id) => dbMembership(env.companyA, id))));
    });
  });

  describe('hierarquia', () => {
    it('ADMIN não altera, desativa nem redefine a senha de OWNER ou de outro ADMIN (403) e não promove a ADMIN/OWNER', async () => {
      const admin = await login(env.companyA, 'ADMIN');
      const owner = await login(env.companyA, 'OWNER');
      const otherAdmin = await login(env.companyA, 'ADMIN');
      const agent = await login(env.companyA, 'AGENT');
      for (const target of [owner, otherAdmin]) {
        const url = `${base(env.companyA)}/${target.membershipId}`;
        assert.equal((await call('PATCH', url, admin, { role: 'AGENT' })).statusCode, 403);
        assert.equal((await call('PATCH', url, admin, { status: 'DISABLED' })).statusCode, 403);
        assert.equal(
          (await call('POST', `${url}/password`, admin, { newPassword: NEW_PASSWORD })).statusCode,
          403,
        );
      }
      for (const role of ['ADMIN', 'OWNER'] as const) {
        assert.equal(
          (await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, admin, { role }))
            .statusCode,
          403,
        );
      }
      // O banco continua intacto.
      assert.equal((await dbMembership(env.companyA, owner.membershipId)).role, 'OWNER');
      assert.equal((await dbMembership(env.companyA, otherAdmin.membershipId)).role, 'ADMIN');
      assert.equal((await dbMembership(env.companyA, agent.membershipId)).role, 'AGENT');
      // E o que é permitido funciona: AGENT <-> VIEWER.
      const ok = await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, admin, {
        role: 'VIEWER',
      });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json<MembershipBody>().role, 'VIEWER');
    });

    it('OWNER altera, desativa, redefine a senha e promove a qualquer papel', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const admin = await login(env.companyA, 'ADMIN');
      const agent = await login(env.companyA, 'AGENT');
      const url = (u: IssuedLogin): string => `${base(env.companyA)}/${u.membershipId}`;
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
      assert.equal((await dbMembership(env.companyA, agent.membershipId)).role, 'OWNER');
      assert.equal((await dbMembership(env.companyA, admin.membershipId)).status, 'DISABLED');
    });

    it('ninguém altera o próprio papel nem o próprio estado, nem a própria senha por aqui (403)', async () => {
      for (const role of MEMBERSHIP_ROLES.filter((r) => r === 'OWNER' || r === 'ADMIN')) {
        const me = await login(env.companyA, role);
        // Um segundo OWNER, para provar que não é a regra do último OWNER que barra.
        await login(env.companyA, 'OWNER');
        const url = `${base(env.companyA)}/${me.membershipId}`;
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
        assert.equal((await dbMembership(env.companyA, me.membershipId)).role, role);
        assert.equal((await dbMembership(env.companyA, me.membershipId)).status, 'ACTIVE');
      }
    });

    it('auto-promoção: AGENT e ADMIN pedindo OWNER para si levam 403 e o banco fica intacto', async () => {
      const agent = await login(env.companyA, 'AGENT');
      const admin = await login(env.companyA, 'ADMIN');
      assert.equal(
        (
          await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, agent, {
            role: 'OWNER',
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await call('PATCH', `${base(env.companyA)}/${admin.membershipId}`, admin, {
            role: 'OWNER',
          })
        ).statusCode,
        403,
      );
      assert.equal((await dbMembership(env.companyA, agent.membershipId)).role, 'AGENT');
      assert.equal((await dbMembership(env.companyA, admin.membershipId)).role, 'ADMIN');
      assert.equal(env.auth.audit.events.length, 0);
    });
  });

  describe('último OWNER', () => {
    it('com dois OWNER, um rebaixa o outro; o único que sobra não pode ser tocado por ninguém (nada muda)', async () => {
      const first = await login(env.companyA, 'OWNER');
      const second = await login(env.companyA, 'OWNER');
      const admin = await login(env.companyA, 'ADMIN');
      const down = await call('PATCH', `${base(env.companyA)}/${first.membershipId}`, second, {
        role: 'ADMIN',
      });
      assert.equal(down.statusCode, 200);
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyA.id), 1);
      const sole = `${base(env.companyA)}/${second.membershipId}`;
      // O sobrante não se altera (403, ninguém altera a si mesmo), o ADMIN não o alcança (403) e
      // o OWNER rebaixado, mesmo com o token antigo, age com o papel do banco (403).
      for (const who of [second, admin]) {
        for (const patch of [{ role: 'AGENT' }, { status: 'DISABLED' }]) {
          assert.equal((await call('PATCH', sole, who, patch)).statusCode, 403);
        }
      }
      // O rebaixado perdeu as sessões (a revogação vem depois do commit): o token antigo é 401.
      assert.equal((await call('PATCH', sole, first, { role: 'AGENT' })).statusCode, 401);
      assert.equal((await dbMembership(env.companyA, second.membershipId)).role, 'OWNER');
      assert.equal((await dbMembership(env.companyA, second.membershipId)).status, 'ACTIVE');
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyA.id), 1);
    });

    it('OWNER desativado não conta como OWNER ativo; reativar não é bloqueado e volta a contar', async () => {
      const actor = await login(env.companyA, 'OWNER');
      const other = await login(env.companyA, 'OWNER');
      const third = await login(env.companyA, 'OWNER');
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyA.id), 3);
      const disable = await call('PATCH', `${base(env.companyA)}/${other.membershipId}`, actor, {
        status: 'DISABLED',
      });
      assert.equal(disable.statusCode, 200);
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyA.id), 2);
      const demote = await call('PATCH', `${base(env.companyA)}/${third.membershipId}`, actor, {
        role: 'AGENT',
      });
      assert.equal(demote.statusCode, 200);
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyA.id), 1);
      const enable = await call('PATCH', `${base(env.companyA)}/${other.membershipId}`, actor, {
        status: 'ACTIVE',
      });
      assert.equal(enable.statusCode, 200);
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyA.id), 2);
    });
  });

  describe('PATCH sem efeito e inválido', () => {
    it('papel e estado iguais ao atual: 200 sem auditoria; PATCH vazio ou com campo estranho é 400', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const agent = await login(env.companyA, 'AGENT');
      const url = `${base(env.companyA)}/${agent.membershipId}`;
      const same = await call('PATCH', url, owner, { role: 'AGENT', status: 'ACTIVE' });
      assert.equal(same.statusCode, 200);
      assert.equal(env.auth.audit.events.length, 0);
      for (const payload of [{}, { email: 'x@exemplo.test' }, { role: 'AGENT', extra: 1 }]) {
        assert.equal((await call('PATCH', url, owner, payload)).statusCode, 400);
      }
      assert.equal(env.auth.audit.events.length, 0);
    });

    it(':membershipId que não é UUID, inexistente ou de outra empresa: o mesmo 404', async () => {
      const ownerA = await login(env.companyA, 'OWNER');
      const membershipB = await login(env.companyB, 'AGENT');
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const seen = new Set<string>();
      for (const id of ['nao-e-uuid', randomUUID(), membershipB.membershipId]) {
        for (const suffix of ['', '/password']) {
          const method = suffix === '' ? 'PATCH' : 'POST';
          const payload = suffix === '' ? { role: 'VIEWER' } : { newPassword: NEW_PASSWORD };
          const response = await call(
            method,
            `${base(env.companyA)}/${id}${suffix}`,
            ownerA,
            payload,
          );
          assert.equal(response.statusCode, 404, `${id}${suffix}`);
          seen.add(strip(response.body));
        }
      }
      assert.equal(seen.size, 1);
      assert.equal((await dbMembership(env.companyB, membershipB.membershipId)).role, 'AGENT');
    });
  });

  describe('efeito imediato nas sessões', () => {
    for (const scenario of [
      {
        label: 'mudar o papel',
        act: (owner: IssuedLogin, target: IssuedLogin) =>
          call('PATCH', `${base(env.companyA)}/${target.membershipId}`, owner, { role: 'VIEWER' }),
      },
      {
        label: 'desativar',
        act: (owner: IssuedLogin, target: IssuedLogin) =>
          call('PATCH', `${base(env.companyA)}/${target.membershipId}`, owner, {
            status: 'DISABLED',
          }),
      },
      {
        label: 'redefinir a senha',
        act: (owner: IssuedLogin, target: IssuedLogin) =>
          call('POST', `${base(env.companyA)}/${target.membershipId}/password`, owner, {
            newPassword: NEW_PASSWORD,
          }),
      },
    ]) {
      it(`depois de ${scenario.label}, o access token ainda válido do alvo é recusado e o refresh falha; outros não são afetados`, async () => {
        const owner = await login(env.companyA, 'OWNER');
        const target = await login(env.companyA, 'AGENT');
        const bystander = await login(env.companyA, 'AGENT');
        const otherCompany = await login(env.companyB, 'AGENT');
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
        // Outras pessoas (mesma empresa e outra empresa) seguem autenticadas.
        for (const who of [bystander, owner, otherCompany]) {
          assert.equal((await call('GET', '/auth/me', who)).statusCode, 200);
        }
      });
    }

    it('depois de mudar o papel, o login traz o papel novo; desativado não loga; senha nova vale e a antiga não', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const target = await login(env.companyA, 'AGENT');
      await call('PATCH', `${base(env.companyA)}/${target.membershipId}`, owner, {
        role: 'VIEWER',
      });
      const relogin = await env.auth.service.login({
        companySlug: env.companyA.slug,
        email: target.email,
        password: TEST_PASSWORD,
      });
      assert.ok(relogin.ok);
      const identity = await env.auth.service.authenticate(relogin.value.accessToken);
      assert.ok(
        identity.ok && identity.value.kind === 'membership' && identity.value.role === 'VIEWER',
      );

      await call('POST', `${base(env.companyA)}/${target.membershipId}/password`, owner, {
        newPassword: NEW_PASSWORD,
      });
      assert.ok(
        !(
          await env.auth.service.login({
            companySlug: env.companyA.slug,
            email: target.email,
            password: TEST_PASSWORD,
          })
        ).ok,
      );
      assert.ok(
        (
          await env.auth.service.login({
            companySlug: env.companyA.slug,
            email: target.email,
            password: NEW_PASSWORD,
          })
        ).ok,
      );

      await call('PATCH', `${base(env.companyA)}/${target.membershipId}`, owner, {
        status: 'DISABLED',
      });
      assert.ok(
        !(
          await env.auth.service.login({
            companySlug: env.companyA.slug,
            email: target.email,
            password: NEW_PASSWORD,
          })
        ).ok,
      );
    });

    it('reativar não revoga as sessões do alvo', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const target = await login(env.companyA, 'AGENT');
      await env.auth.memberships.update(env.companyA.id, target.membershipId, {
        status: 'DISABLED',
      });
      const response = await call('PATCH', `${base(env.companyA)}/${target.membershipId}`, owner, {
        status: 'ACTIVE',
      });
      assert.equal(response.statusCode, 200);
      assert.equal((await call('GET', '/auth/me', target)).statusCode, 200);
    });

    it('Redis fora DEPOIS do commit: 503, a mudança e a auditoria ficam gravadas e repetir o PATCH refaz a revogação', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const target = await login(env.companyA, 'AGENT');
      env.store.failRevokeAllWith = new ServiceUnavailableError('redis fora');
      const url = `${base(env.companyA)}/${target.membershipId}`;
      const first = await call('PATCH', url, owner, { role: 'VIEWER' });
      assert.equal(first.statusCode, 503);
      assert.equal(errorCode(first), 'SERVICE_UNAVAILABLE');
      assert.equal((await dbMembership(env.companyA, target.membershipId)).role, 'VIEWER');
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
      const owner = await login(env.companyA, 'OWNER');
      const admin = await login(env.companyA, 'ADMIN');
      env.store.failRevokeAllWith = new ServiceUnavailableError('redis fora');
      const demote = await call('PATCH', `${base(env.companyA)}/${admin.membershipId}`, owner, {
        role: 'AGENT',
      });
      assert.equal(demote.statusCode, 503);
      // O token do ex-ADMIN ainda é aceito pelo hook e o claim diz ADMIN; o service o recusa.
      const create = await call('POST', base(env.companyA), admin, {
        email: 'escalada@exemplo.test',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(create.statusCode, 403);
      assert.equal(
        await env.auth.memberships.findCredentialsByEmail(env.companyA.id, 'escalada@exemplo.test'),
        null,
      );
    });
  });

  describe('auditoria e privacidade', () => {
    it('cada operação grava um evento com ator, alvo, ação e papéis; reativar e desativar são ações distintas', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const created = (
        await call('POST', base(env.companyA), owner, {
          email: 'auditado@exemplo.test',
          password: NEW_PASSWORD,
          role: 'AGENT',
        })
      ).json<MembershipBody>();
      const url = `${base(env.companyA)}/${created.id}`;
      await call('PATCH', url, owner, { role: 'ADMIN' });
      await call('PATCH', url, owner, { status: 'DISABLED' });
      await call('PATCH', url, owner, { status: 'ACTIVE' });
      await call('POST', `${url}/password`, owner, { newPassword: NEW_PASSWORD });
      const events = env.auth.audit.events;
      assert.deepEqual(
        events.map((event) => event.action),
        [
          'MEMBERSHIP_CREATED',
          'MEMBERSHIP_ROLE_CHANGED',
          'MEMBERSHIP_DISABLED',
          'MEMBERSHIP_ENABLED',
          'MEMBERSHIP_PASSWORD_RESET',
        ],
      );
      for (const event of events) {
        assert.equal(event.actorMembershipId, owner.membershipId);
        assert.equal(event.targetMembershipId, created.id);
        assert.equal(event.companyId, env.companyA.id);
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
      const owner = await login(env.companyA, 'OWNER');
      const agent = await login(env.companyA, 'AGENT');
      await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, owner, {
        role: 'VIEWER',
        status: 'DISABLED',
      });
      assert.deepEqual(
        env.auth.audit.events.map((event) => event.action),
        ['MEMBERSHIP_ROLE_CHANGED', 'MEMBERSHIP_DISABLED'],
      );
    });

    it('falha ao gravar a trilha desfaz a mudança do usuário (mesma transação) e não revoga sessão', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const agent = await login(env.companyA, 'AGENT');
      env.auth.audit.failWith = new Error('falha de teste na trilha');
      const response = await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, owner, {
        role: 'VIEWER',
      });
      assert.equal(response.statusCode, 500);
      env.auth.audit.failWith = undefined;
      assert.equal((await dbMembership(env.companyA, agent.membershipId)).role, 'AGENT');
      assert.equal(env.auth.audit.events.length, 0);
      assert.equal((await call('GET', '/auth/me', agent)).statusCode, 200);
      // Criar com a trilha falhando também não deixa o usuário.
      env.auth.audit.failWith = new Error('falha de teste na trilha');
      const created = await call('POST', base(env.companyA), owner, {
        email: 'fantasma@exemplo.test',
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(created.statusCode, 500);
      assert.equal(
        await env.auth.memberships.findCredentialsByEmail(env.companyA.id, 'fantasma@exemplo.test'),
        null,
      );
    });

    it('o log audit traz só ids e enum; e-mail, senha, hash e tokens secretos não aparecem em log, métrica nem erro', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const secretEmail = 'segredo-total@exemplo.test';
      const bodies: string[] = [];
      const created = await call('POST', base(env.companyA), owner, {
        email: secretEmail,
        password: SECRET_PASSWORD,
        role: 'AGENT',
      });
      // (a resposta de sucesso devolve o e-mail a quem o criou: só as de ERRO entram na conferência)
      const id = created.json<MembershipBody>().id;
      for (const response of [
        await call('PATCH', `${base(env.companyA)}/${id}`, owner, { role: 'VIEWER' }),
        await call('POST', `${base(env.companyA)}/${id}/password`, owner, {
          newPassword: SECRET_PASSWORD,
        }),
        await call('POST', `${base(env.companyA)}/${id}/password`, owner, { newPassword: 'x' }),
        await call('POST', base(env.companyA), owner, {
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
                  'membershipId',
                  'operation',
                ].includes(key),
            )
            .sort(),
          [
            'action',
            'actorMembershipId',
            'companyId',
            'event',
            'fromRole',
            'targetMembershipId',
            'toRole',
          ],
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

    it('membership_admin_actions_total conta por ação, sem id nem e-mail', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const created = (
        await call('POST', base(env.companyA), owner, {
          email: 'metrica@exemplo.test',
          password: NEW_PASSWORD,
          role: 'AGENT',
        })
      ).json<MembershipBody>();
      await call('PATCH', `${base(env.companyA)}/${created.id}`, owner, { role: 'VIEWER' });
      const text = await env.metrics.render();
      assert.match(text, /membership_admin_actions_total\{action="MEMBERSHIP_CREATED"\} 1/);
      assert.match(text, /membership_admin_actions_total\{action="MEMBERSHIP_ROLE_CHANGED"\} 1/);
      assert.ok(!text.includes(created.id) && !text.includes('metrica@'));
    });
  });

  describe('isolamento entre empresas (ponta a ponta com duas empresas)', () => {
    it('OWNER de A com o companyId de B ou o membershipId de um usuário de B recebe 404 idêntico ao de inexistente; nada de B é lido nem alterado', async () => {
      const ownerA = await login(env.companyA, 'OWNER');
      const ownerB = await login(env.companyB, 'OWNER');
      const victim = await login(env.companyB, 'AGENT');
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const attempts: readonly [string, string, object?][] = [
        ['GET', `/admin/companies/${env.companyB.id}/memberships`],
        [
          'POST',
          `/admin/companies/${env.companyB.id}/memberships`,
          { email: 'x@exemplo.test', password: NEW_PASSWORD, role: 'AGENT' },
        ],
        [
          'PATCH',
          `/admin/companies/${env.companyB.id}/memberships/${victim.membershipId}`,
          { role: 'VIEWER' },
        ],
        [
          'POST',
          `/admin/companies/${env.companyB.id}/memberships/${victim.membershipId}/password`,
          { newPassword: NEW_PASSWORD },
        ],
        ['PATCH', `${base(env.companyA)}/${victim.membershipId}`, { role: 'VIEWER' }],
        [
          'POST',
          `${base(env.companyA)}/${victim.membershipId}/password`,
          { newPassword: NEW_PASSWORD },
        ],
      ];
      // Cada tentativa é comparada com o seu equivalente "inexistente": :companyId alheio = empresa
      // inexistente; membershipId de outra empresa = usuário inexistente.
      const ghostCompany = randomUUID();
      const ghostMembership = randomUUID();
      const companyBodies = new Set<string>();
      const membershipBodies = new Set<string>();
      for (const [method, url, payload] of attempts) {
        const response = await call(method as 'GET', url, ownerA, payload);
        assert.equal(response.statusCode, 404, `${method} ${url}`);
        (url.includes(`/companies/${env.companyB.id}/`) ? companyBodies : membershipBodies).add(
          strip(response.body),
        );
      }
      const ghostCompanyResponse = await call(
        'GET',
        `/admin/companies/${ghostCompany}/memberships`,
        ownerA,
      );
      const ghostMembershipResponse = await call(
        'PATCH',
        `${base(env.companyA)}/${ghostMembership}`,
        ownerA,
        {
          role: 'VIEWER',
        },
      );
      assert.deepEqual([...companyBodies], [strip(ghostCompanyResponse.body)]);
      assert.deepEqual([...membershipBodies], [strip(ghostMembershipResponse.body)]);
      assert.equal((await dbMembership(env.companyB, victim.membershipId)).role, 'AGENT');
      assert.equal(await env.auth.memberships.countActiveOwners(env.companyB.id), 1);
      assert.equal(env.auth.audit.events.length, 0);
      // O OWNER de B segue com acesso ao que é dele.
      assert.equal((await call('GET', base(env.companyB), ownerB)).statusCode, 200);
    });
  });

  describe('GET /audit-events', () => {
    const auditUrl = (company: Company): string => `/admin/companies/${company.id}/audit-events`;
    interface AuditBody {
      items: {
        id: string;
        action: string;
        actorMembershipId: string;
        targetMembershipId: string;
        fromRole: MembershipRole | null;
        toRole: MembershipRole | null;
        createdAt: string;
      }[];
      nextCursor: string | null;
    }

    it('só os eventos da empresa do token, mais recentes primeiro, só ids e enum (sem e-mail)', async () => {
      const ownerA = await login(env.companyA, 'OWNER');
      const ownerB = await login(env.companyB, 'OWNER');
      const agent = await login(env.companyA, 'AGENT');
      const agentB = await login(env.companyB, 'AGENT');
      await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, ownerA, {
        role: 'VIEWER',
      });
      await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, ownerA, {
        status: 'DISABLED',
      });
      await call('PATCH', `${base(env.companyB)}/${agentB.membershipId}`, ownerB, {
        role: 'ADMIN',
      });
      const response = await call('GET', auditUrl(env.companyA), ownerA);
      assert.equal(response.statusCode, 200);
      const body = response.json<AuditBody>();
      assert.deepEqual(
        body.items.map((item) => item.action),
        ['MEMBERSHIP_DISABLED', 'MEMBERSHIP_ROLE_CHANGED'],
      );
      assert.deepEqual(Object.keys(body.items[0] ?? {}).sort(), [
        'action',
        'actorMembershipId',
        'createdAt',
        'fromRole',
        'id',
        'targetMembershipId',
        'toRole',
      ]);
      assert.ok(body.items.every((item) => item.targetMembershipId === agent.membershipId));
      assert.ok(!response.body.includes(ownerA.email) && !response.body.includes(agent.email));
      // A empresa B enxerga só o dele.
      const bodyB = (await call('GET', auditUrl(env.companyB), ownerB)).json<AuditBody>();
      assert.deepEqual(
        bodyB.items.map((item) => item.targetMembershipId),
        [agentB.membershipId],
      );
    });

    it('pagina por cursor sem repetir nem perder evento', async () => {
      const owner = await login(env.companyA, 'OWNER');
      const agent = await login(env.companyA, 'AGENT');
      for (const role of ['VIEWER', 'ADMIN', 'VIEWER', 'ADMIN', 'AGENT'] as const) {
        await call('PATCH', `${base(env.companyA)}/${agent.membershipId}`, owner, { role });
        // O refresh do alvo fica inválido, mas o ator (OWNER) segue autenticado.
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await call(
          'GET',
          `${auditUrl(env.companyA)}?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
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

    it('sem token 401; PlatformAdmin 403; :companyId alheio 404 igual ao inexistente', async () => {
      const ownerA = await login(env.companyA, 'OWNER');
      const platform = await env.auth.platformToken();
      assert.equal((await call('GET', auditUrl(env.companyA))).statusCode, 401);
      assert.equal((await call('GET', auditUrl(env.companyA), platform)).statusCode, 403);
      const strip = (body: string): string => body.replace(/"requestId":"[^"]*"/, '');
      const alien = await call('GET', auditUrl(env.companyB), ownerA);
      const ghost = await call('GET', `/admin/companies/${randomUUID()}/audit-events`, ownerA);
      assert.equal(alien.statusCode, 404);
      assert.equal(strip(alien.body), strip(ghost.body));
    });

    it('a trilha é só leitura pela API: não há rota de escrita nem de remoção', async () => {
      const owner = await login(env.companyA, 'OWNER');
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
        const response = await env.app.inject({
          method,
          url: auditUrl(env.companyA),
          headers: bearer(owner.accessToken),
          payload: {},
        });
        assert.equal(response.statusCode, 404, method);
      }
    });
  });
});
