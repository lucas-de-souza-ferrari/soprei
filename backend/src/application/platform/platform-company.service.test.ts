import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CompanyId, MembershipId, PlatformAdminId } from '../../domain/index.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import {
  InMemoryPlatformAuditRepository,
  InMemoryPlatformCompanyUnitOfWork,
} from '../../test-support/in-memory-platform.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type { LoginFailure } from '../auth/auth.service.js';
import type { PlatformIdentity } from '../auth/identity.js';
import { CONFIRMATION_MISMATCH, PlatformCompanyService } from './platform-company.service.js';
import { CONFIRMATION_INVALID } from './platform-confirmation.js';

const ADMIN: PlatformIdentity = {
  kind: 'platform',
  adminId: PlatformAdminId.parse(randomUUID()),
  sessionId: randomUUID(),
};
const CODE = '123456';
const SLUG = 'padaria-sigilosa';
const NAME = 'Padaria Sigilosa do Teste';

interface World {
  readonly service: PlatformCompanyService;
  readonly uow: InMemoryPlatformCompanyUnitOfWork;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly calls: string[];
  readonly confirmCodes: (string | undefined)[];
  readonly metrics: string[];
  readonly logs: ReturnType<typeof captureLogs>;
  readonly company: CompanyId;
  readonly other: CompanyId;
  readonly owner: MembershipId;
  readonly agent: MembershipId;
  readonly unverified: MembershipId;
  readonly legacy: MembershipId;
  /** Vínculo da outra empresa. */
  readonly foreign: MembershipId;
  confirmResult: Result<void, LoginFailure>;
  redisDown: boolean;
  unsubscribeFails: boolean;
}

function setup(): World {
  const audit = new InMemoryPlatformAuditRepository();
  const uow = new InMemoryPlatformCompanyUnitOfWork(audit);
  const company = CompanyId.parse(randomUUID());
  const other = CompanyId.parse(randomUUID());
  uow.addCompany(company, SLUG, NAME);
  uow.addCompany(other, 'outra-empresa', 'Outra');
  uow.channels.set(company, { wabaId: '1234567890', tokenCiphertext: 'cifrado' });
  const owner = MembershipId.parse(randomUUID());
  const agent = MembershipId.parse(randomUUID());
  const unverified = MembershipId.parse(randomUUID());
  const legacy = MembershipId.parse(randomUUID());
  const foreign = MembershipId.parse(randomUUID());
  const verifiedAccount = { status: 'ACTIVE' as const, verified: true };
  uow.addMembership(company, owner, { role: 'OWNER', status: 'ACTIVE', account: verifiedAccount });
  uow.addMembership(company, agent, { role: 'AGENT', status: 'ACTIVE', account: verifiedAccount });
  uow.addMembership(company, unverified, {
    role: 'VIEWER',
    status: 'ACTIVE',
    account: { status: 'ACTIVE', verified: false },
  });
  uow.addMembership(company, legacy, { role: 'ADMIN', status: 'ACTIVE', account: null });
  uow.addMembership(other, foreign, { role: 'OWNER', status: 'ACTIVE', account: verifiedAccount });
  const calls: string[] = [];
  const confirmCodes: (string | undefined)[] = [];
  const metrics: string[] = [];
  const logs = captureLogs();
  const world: World = {
    uow,
    audit,
    calls,
    confirmCodes,
    metrics,
    logs,
    company,
    other,
    owner,
    agent,
    unverified,
    legacy,
    foreign,
    confirmResult: Result.ok(undefined),
    redisDown: false,
    unsubscribeFails: false,
    service: undefined as unknown as PlatformCompanyService,
  };
  const service = new PlatformCompanyService({
    companies: uow,
    confirmer: {
      confirmPlatformCode: (adminId, code) => {
        assert.equal(adminId, ADMIN.adminId);
        confirmCodes.push(code);
        return Promise.resolve(world.confirmResult);
      },
    },
    bearerSessions: {
      revokeAllSessions: (scope, subjectId) => {
        // Depois do commit: a trilha já está gravada quando a revogação começa.
        calls.push(`bearer:${scope}:${subjectId}:events=${String(audit.events.length)}`);
        if (world.redisDown) return Promise.reject(new ServiceUnavailableError('Redis fora'));
        return Promise.resolve();
      },
    },
    channel: {
      unsubscribeRemoved: (companyId, removed) => {
        calls.push(
          `unsubscribe:${companyId}:${removed.wabaId}:events=${String(audit.events.length)}`,
        );
        if (world.unsubscribeFails) return Promise.reject(new Error('Meta fora'));
        return Promise.resolve();
      },
    },
    logger: logs.logger,
    metrics: {
      countPlatformAction: (action) => {
        metrics.push(action);
      },
    },
  });
  return Object.assign(world, { service });
}

describe('PlatformCompanyService: renomear (spec 045, E3a)', () => {
  it('renomeia com trilha (sem o nome) e métrica; o mesmo nome é 204 sem evento', async () => {
    const world = setup();
    assert.equal(await world.service.rename(ADMIN, world.company, '  Nome Novo  ', 'OTHER'), true);
    assert.equal(world.uow.names.get(world.company), 'Nome Novo');
    assert.equal(world.audit.events.length, 1);
    const [event] = world.audit.events;
    assert.equal(event?.action, 'COMPANY_RENAMED');
    assert.equal(event.adminId, ADMIN.adminId);
    assert.equal(event.subjectCompanyId, world.company);
    assert.equal(event.reason, 'OTHER');
    assert.deepEqual(world.metrics, ['company_renamed']);
    assert.equal(await world.service.rename(ADMIN, world.company, 'Nome Novo', 'OTHER'), false);
    assert.equal(world.audit.events.length, 1);
  });

  it('nome vazio ou longo demais = 400; empresa inexistente, removida ou id malformado = 404', async () => {
    const world = setup();
    await assert.rejects(
      world.service.rename(ADMIN, world.company, '   ', 'OTHER'),
      ValidationError,
    );
    await assert.rejects(
      world.service.rename(ADMIN, world.company, 'x'.repeat(121), 'OTHER'),
      ValidationError,
    );
    await assert.rejects(world.service.rename(ADMIN, 'nao-uuid', 'Nome', 'OTHER'), NotFoundError);
    await assert.rejects(world.service.rename(ADMIN, randomUUID(), 'Nome', 'OTHER'), NotFoundError);
    world.uow.removed.add(world.other);
    await assert.rejects(world.service.rename(ADMIN, world.other, 'Nome', 'OTHER'), NotFoundError);
    assert.equal(world.audit.events.length, 0);
  });

  it('trilha que falha: o nome não muda', async () => {
    const world = setup();
    world.uow.failAudit = true;
    await assert.rejects(world.service.rename(ADMIN, world.company, 'Outro', 'OTHER'));
    assert.equal(world.uow.names.get(world.company), NAME);
  });
});

describe('PlatformCompanyService: remover e restaurar (spec 045, E3a)', () => {
  it('slug errado = 400 CONFIRMATION_MISMATCH sem gastar o código nem mudar nada', async () => {
    const world = setup();
    await assert.rejects(
      world.service.remove(ADMIN, world.company, 'outro-slug', 'ABUSE', CODE),
      (error: unknown) => error instanceof ValidationError && error.code === CONFIRMATION_MISMATCH,
    );
    assert.deepEqual(world.confirmCodes, []);
    assert.equal(world.uow.removed.has(world.company), false);
    assert.equal(world.audit.events.length, 0);
  });

  it('sem código ou com código errado = 400 CONFIRMATION_INVALID sem efeito; bloqueado = 429', async () => {
    const world = setup();
    const invalid = (error: unknown): boolean =>
      error instanceof ValidationError && error.code === CONFIRMATION_INVALID;
    await assert.rejects(
      world.service.remove(ADMIN, world.company, SLUG, 'ABUSE', undefined),
      invalid,
    );
    world.confirmResult = Result.err({ reason: 'invalid_credentials' });
    await assert.rejects(world.service.remove(ADMIN, world.company, SLUG, 'ABUSE', CODE), invalid);
    world.confirmResult = Result.err({ reason: 'locked', retryAfterSeconds: 90 });
    await assert.rejects(
      world.service.remove(ADMIN, world.company, SLUG, 'ABUSE', CODE),
      (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 90,
    );
    assert.equal(world.uow.removed.has(world.company), false);
    assert.equal(world.audit.events.length, 0);
  });

  it('remove: soft delete, conexão apagada, convites revogados, trilha e, depois, a desassinatura', async () => {
    const world = setup();
    await world.service.remove(ADMIN, world.company, SLUG, 'ABUSE', CODE);
    assert.deepEqual(world.confirmCodes, [CODE]);
    assert.equal(world.uow.removed.has(world.company), true);
    assert.equal(world.uow.channels.has(world.company), false);
    assert.deepEqual(world.uow.invitationsRevoked, [world.company]);
    assert.deepEqual(
      world.audit.events.map((event) => [event.action, event.subjectCompanyId, event.reason]),
      [['COMPANY_REMOVED', world.company, 'ABUSE']],
    );
    assert.deepEqual(world.calls, [`unsubscribe:${world.company}:1234567890:events=1`]);
    assert.deepEqual(world.metrics, ['company_removed']);
    // Já removida: a remoção é 404 (restaurar é a outra rota).
    await assert.rejects(
      world.service.remove(ADMIN, world.company, SLUG, 'ABUSE', CODE),
      NotFoundError,
    );
  });

  it('a desassinatura que falha não desfaz nada nem sobe ao admin', async () => {
    const world = setup();
    world.unsubscribeFails = true;
    await world.service.remove(ADMIN, world.company, SLUG, 'OTHER', CODE);
    assert.equal(world.uow.removed.has(world.company), true);
    assert.equal(world.audit.events.length, 1);
  });

  it('trilha que falha: a empresa não é removida e nada é desassinado', async () => {
    const world = setup();
    world.uow.failAudit = true;
    await assert.rejects(world.service.remove(ADMIN, world.company, SLUG, 'OTHER', CODE));
    assert.equal(world.uow.removed.has(world.company), false);
    assert.equal(world.uow.channels.has(world.company), true);
    assert.deepEqual(world.calls, []);
  });

  it('restaura com código e trilha; não removida = 204 sem evento; inexistente = 404', async () => {
    const world = setup();
    await world.service.remove(ADMIN, world.company, SLUG, 'OTHER', CODE);
    await assert.rejects(
      world.service.restore(ADMIN, world.company, 'OTHER', undefined),
      (error: unknown) => error instanceof ValidationError && error.code === CONFIRMATION_INVALID,
    );
    assert.equal(world.uow.removed.has(world.company), true);
    assert.equal(await world.service.restore(ADMIN, world.company, 'OWNER_REQUEST', CODE), true);
    assert.equal(world.uow.removed.has(world.company), false);
    // O canal não volta: o OWNER reconecta.
    assert.equal(world.uow.channels.has(world.company), false);
    assert.equal(world.audit.events.at(-1)?.action, 'COMPANY_RESTORED');
    assert.equal(await world.service.restore(ADMIN, world.company, 'OWNER_REQUEST', CODE), false);
    assert.equal(world.audit.events.length, 2);
    await assert.rejects(world.service.restore(ADMIN, randomUUID(), 'OTHER', CODE), NotFoundError);
  });
});

describe('PlatformCompanyService: papel do vínculo (spec 045, E3a)', () => {
  it('mudar entre papéis sem OWNER dispensa o código; trilha com vínculo e papéis; revoga a Bearer depois', async () => {
    const world = setup();
    assert.equal(
      await world.service.changeRole(
        ADMIN,
        world.company,
        world.agent,
        'ADMIN',
        'OTHER',
        undefined,
      ),
      true,
    );
    assert.deepEqual(world.confirmCodes, []);
    assert.equal(world.uow.membership(world.company, world.agent)?.role, 'ADMIN');
    const [event] = world.audit.events;
    assert.equal(event?.action, 'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM');
    assert.equal(event.subjectCompanyId, world.company);
    assert.equal(event.subjectMembershipId, world.agent);
    assert.equal(event.fromRole, 'AGENT');
    assert.equal(event.toRole, 'ADMIN');
    assert.deepEqual(world.calls, [`bearer:${world.company}:${world.agent}:events=1`]);
    assert.deepEqual(world.metrics, ['membership_role_changed_by_platform']);
    // O mesmo papel: 204 sem evento e sem revogar.
    assert.equal(
      await world.service.changeRole(
        ADMIN,
        world.company,
        world.agent,
        'ADMIN',
        'OTHER',
        undefined,
      ),
      false,
    );
    assert.equal(world.audit.events.length, 1);
    assert.equal(world.calls.length, 1);
  });

  it('promover a OWNER ou rebaixar OWNER exige o código', async () => {
    const world = setup();
    const invalid = (error: unknown): boolean =>
      error instanceof ValidationError && error.code === CONFIRMATION_INVALID;
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.agent, 'OWNER', 'OTHER', undefined),
      invalid,
    );
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.owner, 'ADMIN', 'OTHER', undefined),
      invalid,
    );
    assert.equal(world.audit.events.length, 0);
  });

  it('rebaixar o último dono ativo = 409 LAST_OWNER; promover B e rebaixar A transfere a propriedade', async () => {
    const world = setup();
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.owner, 'ADMIN', 'OTHER', CODE),
      (error: unknown) => error instanceof ConflictError && error.code === 'LAST_OWNER',
    );
    assert.equal(world.uow.membership(world.company, world.owner)?.role, 'OWNER');
    await world.service.changeRole(
      ADMIN,
      world.company,
      world.agent,
      'OWNER',
      'OWNER_REQUEST',
      CODE,
    );
    await world.service.changeRole(
      ADMIN,
      world.company,
      world.owner,
      'ADMIN',
      'OWNER_REQUEST',
      CODE,
    );
    assert.equal(world.uow.membership(world.company, world.agent)?.role, 'OWNER');
    assert.equal(world.uow.membership(world.company, world.owner)?.role, 'ADMIN');
    assert.deepEqual(world.confirmCodes, [CODE, CODE, CODE]);
    assert.equal(world.audit.events.length, 2);
  });

  it('dono com a conta desativada não conta como dono ativo: rebaixá-lo não esbarra na regra', async () => {
    const world = setup();
    world.uow.addMembership(world.company, world.agent, {
      role: 'OWNER',
      status: 'ACTIVE',
      account: { status: 'DISABLED', verified: true },
    });
    await world.service.changeRole(ADMIN, world.company, world.agent, 'VIEWER', 'OTHER', CODE);
    assert.equal(world.uow.membership(world.company, world.agent)?.role, 'VIEWER');
  });

  it('promover a OWNER exige vínculo e conta ativos e confirmados (409 MEMBER_NOT_ELIGIBLE)', async () => {
    const world = setup();
    const notEligible = (error: unknown): boolean =>
      error instanceof ConflictError && error.code === 'MEMBER_NOT_ELIGIBLE';
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.unverified, 'OWNER', 'OTHER', CODE),
      notEligible,
    );
    // Vínculo antigo da CLI, sem conta.
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.legacy, 'OWNER', 'OTHER', CODE),
      notEligible,
    );
    world.uow.addMembership(world.company, world.agent, {
      role: 'AGENT',
      status: 'DISABLED',
      account: { status: 'ACTIVE', verified: true },
    });
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.agent, 'OWNER', 'OTHER', CODE),
      notEligible,
    );
    assert.equal(world.audit.events.length, 0);
    // O vínculo da CLI muda de papel normalmente (só não vira OWNER).
    await world.service.changeRole(ADMIN, world.company, world.legacy, 'AGENT', 'OTHER', undefined);
    assert.equal(world.uow.membership(world.company, world.legacy)?.role, 'AGENT');
  });

  it('vínculo de outra empresa, inexistente ou malformado = 404 e nada muda', async () => {
    const world = setup();
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.foreign, 'VIEWER', 'OTHER', CODE),
      NotFoundError,
    );
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, randomUUID(), 'VIEWER', 'OTHER', CODE),
      NotFoundError,
    );
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, 'x', 'VIEWER', 'OTHER', CODE),
      NotFoundError,
    );
    assert.equal(world.uow.membership(world.other, world.foreign)?.role, 'OWNER');
    assert.deepEqual(world.confirmCodes, []);
    assert.equal(world.audit.events.length, 0);
  });

  it('Redis fora na revogação = 503 com o papel e a trilha já gravados', async () => {
    const world = setup();
    world.redisDown = true;
    await assert.rejects(
      world.service.changeRole(ADMIN, world.company, world.agent, 'VIEWER', 'OTHER', undefined),
      ServiceUnavailableError,
    );
    assert.equal(world.uow.membership(world.company, world.agent)?.role, 'VIEWER');
    assert.equal(world.audit.events.length, 1);
  });
});

describe('PlatformCompanyService: desativar e reativar vínculo (spec 045, E3a)', () => {
  it('desativa com trilha e revoga a Bearer; reativa sem revogar; mesmo estado = 204 sem evento', async () => {
    const world = setup();
    assert.equal(
      await world.service.setMembershipStatus(
        ADMIN,
        world.company,
        world.agent,
        'DISABLED',
        'ABUSE',
      ),
      true,
    );
    assert.equal(world.uow.membership(world.company, world.agent)?.status, 'DISABLED');
    assert.equal(world.audit.events[0]?.action, 'MEMBERSHIP_DISABLED_BY_PLATFORM');
    assert.equal(world.audit.events[0].subjectMembershipId, world.agent);
    assert.deepEqual(world.calls, [`bearer:${world.company}:${world.agent}:events=1`]);
    assert.equal(
      await world.service.setMembershipStatus(
        ADMIN,
        world.company,
        world.agent,
        'DISABLED',
        'ABUSE',
      ),
      false,
    );
    assert.equal(
      await world.service.setMembershipStatus(ADMIN, world.company, world.agent, 'ACTIVE', 'OTHER'),
      true,
    );
    assert.equal(world.audit.events[1]?.action, 'MEMBERSHIP_ENABLED_BY_PLATFORM');
    assert.equal(world.calls.length, 1);
    assert.deepEqual(world.metrics, [
      'membership_disabled_by_platform',
      'membership_enabled_by_platform',
    ]);
  });

  it('o último dono ativo não é desativado (409 LAST_OWNER); com outro dono, é', async () => {
    const world = setup();
    await assert.rejects(
      world.service.setMembershipStatus(ADMIN, world.company, world.owner, 'DISABLED', 'OTHER'),
      (error: unknown) => error instanceof ConflictError && error.code === 'LAST_OWNER',
    );
    await world.service.changeRole(ADMIN, world.company, world.agent, 'OWNER', 'OTHER', CODE);
    await world.service.setMembershipStatus(ADMIN, world.company, world.owner, 'DISABLED', 'OTHER');
    assert.equal(world.uow.membership(world.company, world.owner)?.status, 'DISABLED');
  });

  it('reativar exige a conta ativa (409 MEMBER_NOT_ELIGIBLE); vínculo da CLI reativa', async () => {
    const world = setup();
    world.uow.addMembership(world.company, world.agent, {
      role: 'AGENT',
      status: 'DISABLED',
      account: { status: 'DISABLED', verified: true },
    });
    await assert.rejects(
      world.service.setMembershipStatus(ADMIN, world.company, world.agent, 'ACTIVE', 'OTHER'),
      (error: unknown) => error instanceof ConflictError && error.code === 'MEMBER_NOT_ELIGIBLE',
    );
    world.uow.addMembership(world.company, world.legacy, {
      role: 'ADMIN',
      status: 'DISABLED',
      account: null,
    });
    await world.service.setMembershipStatus(ADMIN, world.company, world.legacy, 'ACTIVE', 'OTHER');
    assert.equal(world.uow.membership(world.company, world.legacy)?.status, 'ACTIVE');
  });

  it('vínculo de outra empresa = 404; trilha que falha não muda o estado', async () => {
    const world = setup();
    await assert.rejects(
      world.service.setMembershipStatus(ADMIN, world.company, world.foreign, 'DISABLED', 'OTHER'),
      NotFoundError,
    );
    world.uow.failAudit = true;
    await assert.rejects(
      world.service.setMembershipStatus(ADMIN, world.company, world.agent, 'DISABLED', 'OTHER'),
    );
    assert.equal(world.uow.membership(world.company, world.agent)?.status, 'ACTIVE');
    assert.deepEqual(world.calls, []);
  });
});

describe('PlatformCompanyService: privacidade (spec 045, E3a)', () => {
  it('o log não traz nome da empresa, slug nem código', async () => {
    const world = setup();
    await world.service.rename(ADMIN, world.company, 'Nome Secreto Novo', 'OTHER');
    await world.service.changeRole(ADMIN, world.company, world.agent, 'OWNER', 'OTHER', '654321');
    await world.service.remove(ADMIN, world.company, SLUG, 'OTHER', '987654');
    const text = world.logs.raw();
    for (const secret of [NAME, 'Nome Secreto Novo', SLUG, '654321', '987654']) {
      assert.ok(!logContains(text, secret), `o log não deve conter ${secret}`);
    }
    assert.ok(text.includes(world.company));
  });
});
