import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import type {
  AppointmentView,
  ScheduleService,
} from '../../application/schedule/schedule.service.js';
import { type Company, MEMBERSHIP_ROLES, type MembershipRole } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains, type LogCapture } from '../../test-support/log-capture.js';

const SECRET_LABEL = `Pessoa secreta ${randomUUID()}`;
const SECRET_NAME = `Servico secreto ${randomUUID()}`;
const SECRET_CONTACT = '5511987654321';

function errorOf(body: string): { code: string; message: string } {
  const { error } = JSON.parse(body) as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

type Calls = { method: string; args: unknown[] }[];

const view = (): AppointmentView => ({
  id: randomUUID(),
  kind: 'BOOKING',
  status: 'CONFIRMED',
  source: 'CHANNEL',
  resourceId: randomUUID(),
  resourceName: 'Agenda principal',
  serviceId: randomUUID(),
  serviceName: SECRET_NAME,
  startsAt: new Date('2026-12-01T13:00:00.000Z'),
  endsAt: new Date('2026-12-01T13:30:00.000Z'),
  localDate: '2026-12-01',
  localStart: '10:00',
  localEnd: '10:30',
  weekday: 2,
  customerLabel: SECRET_LABEL,
  cancelledBy: null,
  contactLabel: 'Contato final 4321',
  createdAt: new Date('2026-11-09T11:00:00.000Z'),
});

describe('API da agenda (spec 027): permissões, validação e privacidade', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let logs: LogCapture;
  let companyA: Company;
  let companyB: Company;
  let platform: { authorization: string };
  const calls: Calls = [];
  const tokens = new Map<MembershipRole, { authorization: string }>();

  before(async () => {
    logs = captureLogs();
    const metrics = createMetrics();
    const companies = new InMemoryCompanyRepository();
    testAuth = buildTestAuth({ logger: logs.logger, companies, metrics });
    const resource = (companyId: unknown) => ({
      id: randomUUID(),
      companyId,
      name: 'Agenda principal',
      active: true,
      position: 0,
    });
    const record =
      (method: string, value: () => unknown) =>
      (...args: unknown[]): Promise<unknown> => {
        calls.push({ method, args });
        return Promise.resolve(value());
      };
    const appointmentRow = (): unknown => ({ ...view(), contactRef: SECRET_CONTACT });
    const schedule = {
      getSettings: record('getSettings', () => ({
        companyId: 'x',
        timezone: 'America/Sao_Paulo',
        today: '2026-11-09',
        slotStepMinutes: 30,
        minNoticeMinutes: 120,
        maxAdvanceDays: 60,
        aiBookingEnabled: false,
        aiAutoConfirm: false,
      })),
      updateSettings: record('updateSettings', () => ({
        companyId: 'x',
        timezone: 'America/Sao_Paulo',
        today: '2026-11-09',
        slotStepMinutes: 30,
        minNoticeMinutes: 120,
        maxAdvanceDays: 60,
        aiBookingEnabled: false,
        aiAutoConfirm: false,
      })),
      listResources: record('listResources', () => []),
      createResource: (...args: unknown[]) => {
        calls.push({ method: 'createResource', args });
        return Promise.resolve(resource(args[0]));
      },
      updateResource: (...args: unknown[]) => {
        calls.push({ method: 'updateResource', args });
        return Promise.resolve(resource(args[0]));
      },
      setRules: (...args: unknown[]) => {
        calls.push({ method: 'setRules', args });
        return Promise.resolve({ ...resource(args[0]), windows: [] });
      },
      listServices: record('listServices', () => []),
      createService: record('createService', () => ({
        id: randomUUID(),
        companyId: 'x',
        name: SECRET_NAME,
        durationMinutes: 30,
        bufferMinutes: 0,
        active: true,
        isSample: false,
      })),
      updateService: record('updateService', () => ({
        id: randomUUID(),
        companyId: 'x',
        name: SECRET_NAME,
        durationMinutes: 30,
        bufferMinutes: 0,
        active: true,
        isSample: false,
      })),
      availability: record('availability', () => ({
        timezone: 'America/Sao_Paulo',
        generatedAt: new Date('2026-11-09T11:00:00.000Z'),
        slots: [],
      })),
      listAppointments: record('listAppointments', () => ({
        timezone: 'America/Sao_Paulo',
        today: '2026-11-09',
        items: [view()],
      })),
      createAppointment: (...args: unknown[]) => {
        calls.push({ method: 'createAppointment', args });
        const body = args[2] as { localStart?: string };
        if (body.localStart === '2026-12-01T10:00') {
          return Promise.reject(new ConflictError('Horário indisponível', { code: 'SLOT_TAKEN' }));
        }
        return Promise.resolve(appointmentRow());
      },
      updateAppointment: record('updateAppointment', appointmentRow),
      createBlocks: record('createBlocks', () => [appointmentRow()]),
      cancelBlock: record('cancelBlock', () => undefined),
      view: record('view', () => view()),
      viewMany: record('viewMany', () => [view()]),
    } as unknown as ScheduleService;
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
        schedule,
        scheduleSample: {
          load: (...args: unknown[]) => {
            calls.push({ method: 'sampleLoad', args });
            return Promise.resolve({ created: true });
          },
          remove: () => Promise.resolve({ services: 1 }),
        },
      },
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    headers?: { authorization: string },
    payload?: unknown,
    company: Company = companyA,
  ) =>
    app.inject({
      method,
      url: `/admin/companies/${company.id}/schedule${path}`,
      ...(headers === undefined ? {} : { headers }),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const id = randomUUID();
  const goodAppointment = {
    serviceId: id,
    resourceId: id,
    localStart: '2026-12-02T10:00',
    customerLabel: SECRET_LABEL,
  };
  type Route = [
    'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    string,
    unknown,
    'read' | 'manage' | 'configure',
  ];
  const routes: Route[] = [
    ['GET', '/settings', undefined, 'read'],
    [
      'PUT',
      '/settings',
      {
        timezone: 'America/Sao_Paulo',
        slotStepMinutes: 30,
        minNoticeMinutes: 120,
        maxAdvanceDays: 60,
      },
      'configure',
    ],
    ['GET', '/resources', undefined, 'read'],
    ['POST', '/resources', { name: 'Sala 2' }, 'configure'],
    ['PATCH', `/resources/${id}`, { active: false }, 'configure'],
    [
      'PUT',
      `/resources/${id}/rules`,
      { windows: [{ weekday: 2, start: '09:00', end: '12:00' }] },
      'configure',
    ],
    ['GET', '/services', undefined, 'read'],
    ['POST', '/services', { name: SECRET_NAME, durationMinutes: 30 }, 'configure'],
    ['PATCH', `/services/${id}`, { active: false }, 'configure'],
    ['GET', `/availability?serviceId=${id}&from=2026-12-01&to=2026-12-02`, undefined, 'read'],
    ['GET', '/appointments?from=2026-12-01&to=2026-12-07', undefined, 'read'],
    ['POST', '/appointments', goodAppointment, 'manage'],
    ['PATCH', `/appointments/${id}`, { status: 'CANCELLED' }, 'manage'],
    [
      'POST',
      '/blocks',
      { resourceIds: [id], localStart: '2026-12-03T09:00', localEnd: '2026-12-03T12:00' },
      'manage',
    ],
    ['DELETE', `/blocks/${id}`, undefined, 'manage'],
    ['POST', '/sample', undefined, 'configure'],
    ['DELETE', '/sample', undefined, 'configure'],
  ];
  const allowed: Record<MembershipRole, ReadonlySet<string>> = {
    OWNER: new Set(['read', 'manage', 'configure']),
    ADMIN: new Set(['read', 'manage', 'configure']),
    AGENT: new Set(['read', 'manage']),
    VIEWER: new Set(['read']),
  };

  it('matriz de papéis em todas as rotas; PlatformAdmin 403; sem token 401; empresa alheia 404 antes do 403', async () => {
    for (const [method, path, payload, need] of routes) {
      for (const role of MEMBERSHIP_ROLES) {
        const response = await call(method, path, tokens.get(role), payload);
        const label = `${role} ${method} ${path}: ${String(response.statusCode)}`;
        if (allowed[role].has(need)) assert.ok(response.statusCode < 300, label);
        else assert.equal(response.statusCode, 403, label);
      }
      assert.equal(
        (await call(method, path, platform, payload)).statusCode,
        403,
        `plataforma ${path}`,
      );
      assert.equal(
        (await call(method, path, undefined, payload)).statusCode,
        401,
        `sem token ${path}`,
      );
      assert.equal(
        (await call(method, path, tokens.get('VIEWER'), payload, companyB)).statusCode,
        404,
        `alheia ${path}`,
      );
    }
  });

  it('o service recebe só o CompanyId da identidade; corpo com companyId é 400', async () => {
    calls.length = 0;
    const owner = tokens.get('OWNER');
    assert.ok(owner !== undefined);
    const response = await call('POST', '/appointments', owner, goodAppointment);
    assert.equal(response.statusCode, 201);
    const create = calls.find((entry) => entry.method === 'createAppointment');
    assert.equal(create?.args[0], companyA.id);
    assert.equal((create.args[2] as { localStart: string }).localStart, '2026-12-02T10:00');
    const extra = await call('POST', '/appointments', owner, {
      ...goodAppointment,
      companyId: companyB.id,
    });
    assert.equal(extra.statusCode, 400);
  });

  it('validação estrita: 400 sem ecoar o valor', async () => {
    const owner = tokens.get('OWNER');
    assert.ok(owner !== undefined);
    const secret = `valor-secreto-${randomUUID()}`;
    const bad: [Route[0], string, unknown][] = [
      ['POST', '/services', { name: secret, durationMinutes: 33 }],
      ['POST', '/services', { name: secret, durationMinutes: 30, extra: 1 }],
      ['POST', '/services', { name: secret, durationMinutes: 600 }],
      [
        'PUT',
        `/resources/${id}/rules`,
        { windows: [{ weekday: 8, start: '09:00', end: '12:00' }] },
      ],
      [
        'PUT',
        `/resources/${id}/rules`,
        { windows: [{ weekday: 2, start: '12:00', end: '09:00' }] },
      ],
      [
        'PUT',
        `/resources/${id}/rules`,
        { windows: [{ weekday: 2, start: '09:00', end: '25:00' }] },
      ],
      [
        'PUT',
        '/settings',
        { timezone: secret, slotStepMinutes: 25, minNoticeMinutes: 1, maxAdvanceDays: 1 },
      ],
      [
        'PUT',
        '/settings',
        {
          timezone: 'America/Sao_Paulo',
          slotStepMinutes: 30,
          minNoticeMinutes: 120,
          maxAdvanceDays: 60,
          aiBookingEnabled: false,
          aiAutoConfirm: true,
        },
      ],
      [
        'PUT',
        '/settings',
        {
          timezone: 'America/Sao_Paulo',
          slotStepMinutes: 30,
          minNoticeMinutes: 120,
          maxAdvanceDays: 60,
          aiBookingEnabled: 'sim',
        },
      ],
      ['POST', '/appointments', { ...goodAppointment, customerLabel: 'x'.repeat(61) }],
      ['POST', '/appointments', { ...goodAppointment, customerLabel: `${secret}\n${secret}` }],
      ['POST', '/appointments', { ...goodAppointment, startsAt: '2026-12-02T10:00:00' }],
      [
        'POST',
        '/appointments',
        { ...goodAppointment, localStart: undefined, startsAt: '2026-12-02T10:00:00' },
      ],
      ['POST', '/appointments', { ...goodAppointment, startsAt: '2026-12-02T10:00:00Z' }],
      ['POST', '/appointments', { serviceId: id, resourceId: id }],
      ['PATCH', `/appointments/${id}`, { status: 'CANCELLED', customerLabel: 'x' }],
      ['PATCH', `/appointments/${id}`, {}],
      ['PATCH', `/appointments/${id}`, { status: 'PENDING' }],
      [
        'POST',
        '/blocks',
        { resourceIds: [], startsAt: '2026-12-03T09:00:00Z', endsAt: '2026-12-03T10:00:00Z' },
      ],
      [
        'POST',
        '/blocks',
        { resourceIds: [id], startsAt: '2026-12-03T09:00:00Z', localEnd: '2026-12-03T10:00' },
      ],
      ['GET', `/availability?serviceId=${id}&from=2026-12-01&to=${secret}`, undefined],
      ['GET', '/appointments?from=2026-13-01&to=2026-12-07', undefined],
      ['GET', '/appointments?from=2026-12-01&to=2026-12-07&status=OUTRO', undefined],
    ];
    for (const [method, path, payload] of bad) {
      const response = await call(method, path, owner, payload);
      assert.equal(response.statusCode, 400, `${method} ${path} ${JSON.stringify(payload)}`);
      assert.equal(response.body.includes(secret), false);
    }
    assert.equal(logContains(logs.raw(), secret), false);
  });

  it('startsAt com deslocamento e localStart são aceitos', async () => {
    const owner = tokens.get('OWNER');
    assert.ok(owner !== undefined);
    const withOffset = {
      serviceId: id,
      resourceId: id,
      startsAt: '2026-12-02T10:00:00-03:00',
    };
    assert.equal((await call('POST', '/appointments', owner, withOffset)).statusCode, 201);
    assert.equal(
      (
        await call('POST', '/appointments', owner, {
          ...withOffset,
          startsAt: '2026-12-02T13:00:00Z',
        })
      ).statusCode,
      201,
    );
  });

  it('SLOT_TAKEN sai como 409 com mensagem constante; nenhuma resposta traz contactRef; nada secreto em log', async () => {
    const owner = tokens.get('OWNER');
    assert.ok(owner !== undefined);
    const taken = await call('POST', '/appointments', owner, {
      ...goodAppointment,
      localStart: '2026-12-01T10:00',
    });
    assert.equal(taken.statusCode, 409);
    assert.deepEqual(errorOf(taken.body), { code: 'SLOT_TAKEN', message: 'Horário indisponível' });
    for (const [method, path, payload] of routes) {
      const response = await call(method, path, owner, payload);
      assert.equal(response.body.includes(SECRET_CONTACT), false, `${method} ${path}`);
      assert.equal(response.body.includes('contactRef'), false, `${method} ${path}`);
    }
    const list = await call('GET', '/appointments?from=2026-12-01&to=2026-12-07', owner);
    const item = (
      JSON.parse(list.body) as { items: { contactLabel: string; cancelledBy: unknown }[] }
    ).items[0];
    assert.equal(item?.contactLabel, 'Contato final 4321');
    // Spec 028: quem cancelou sai na listagem (campo aditivo); o telefone nunca.
    assert.ok('cancelledBy' in item);
    const raw = logs.raw();
    for (const secret of [SECRET_LABEL, SECRET_NAME, SECRET_CONTACT, '2026-12-02T10:00']) {
      assert.equal(logContains(raw, secret), false, `vazou em log: ${secret}`);
    }
  });
});
