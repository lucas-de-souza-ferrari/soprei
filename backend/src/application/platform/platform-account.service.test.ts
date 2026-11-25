import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { AccountId, CompanyId, MembershipId, PlatformAdminId } from '../../domain/index.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import {
  InMemoryPlatformAccountUnitOfWork,
  InMemoryPlatformAuditRepository,
} from '../../test-support/in-memory-platform.js';
import { captureLogs } from '../../test-support/log-capture.js';
import type { LoginFailure } from '../auth/auth.service.js';
import type { PlatformIdentity } from '../auth/identity.js';
import { CONFIRMATION_INVALID, PlatformAccountService } from './platform-account.service.js';

const ADMIN: PlatformIdentity = {
  kind: 'platform',
  adminId: PlatformAdminId.parse(randomUUID()),
  sessionId: randomUUID(),
};
const CODE = '123456';

interface World {
  readonly service: PlatformAccountService;
  readonly uow: InMemoryPlatformAccountUnitOfWork;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly calls: string[];
  readonly confirmCodes: (string | undefined)[];
  readonly metrics: string[];
  readonly logs: ReturnType<typeof captureLogs>;
  readonly accountId: AccountId;
  readonly other: AccountId;
  confirmResult: Result<void, LoginFailure>;
  redisDown: boolean;
}

function setup(): World {
  const audit = new InMemoryPlatformAuditRepository();
  const uow = new InMemoryPlatformAccountUnitOfWork(audit);
  const accountId = AccountId.parse(randomUUID());
  const other = AccountId.parse(randomUUID());
  uow.accounts.set(accountId, { status: 'ACTIVE', verified: true });
  uow.accounts.set(other, { status: 'ACTIVE', verified: false });
  const companyA = CompanyId.parse(randomUUID());
  const companyB = CompanyId.parse(randomUUID());
  uow.memberships.push(
    { accountId, companyId: companyA, membershipId: MembershipId.parse(randomUUID()) },
    { accountId, companyId: companyB, membershipId: MembershipId.parse(randomUUID()) },
    // Outra conta nas mesmas empresas: nunca é tocada.
    { accountId: other, companyId: companyA, membershipId: MembershipId.parse(randomUUID()) },
  );
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
    accountId,
    other,
    confirmResult: Result.ok(undefined),
    redisDown: false,
    service: undefined as unknown as PlatformAccountService,
  };
  const service = new PlatformAccountService({
    accounts: uow,
    confirmer: {
      confirmPlatformCode: (adminId, code) => {
        assert.equal(adminId, ADMIN.adminId);
        confirmCodes.push(code);
        return Promise.resolve(world.confirmResult);
      },
    },
    accountSessions: {
      revokeAll: (id) => {
        // Depois do commit: a trilha já está gravada quando a revogação começa.
        calls.push(`revokeAll:${id}:events=${String(audit.events.length)}`);
        if (world.redisDown) return Promise.reject(new ServiceUnavailableError('Redis fora'));
        return Promise.resolve();
      },
    },
    bearerSessions: {
      revokeAllSessions: (scope, subjectId) => {
        calls.push(`bearer:${scope}:${subjectId}`);
        return Promise.resolve();
      },
    },
    mail: {
      requestPasswordResetFor: (id) => {
        calls.push(`reset:${id}:events=${String(audit.events.length)}`);
        return Promise.resolve();
      },
      resendVerificationFor: (id) => {
        calls.push(`verify:${id}:events=${String(audit.events.length)}`);
        return Promise.resolve('sent');
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

function bearerCalls(world: World, accountId: AccountId): string[] {
  return world.uow.memberships
    .filter((ref) => ref.accountId === accountId)
    .map((ref) => `bearer:${ref.companyId}:${ref.membershipId}`);
}

describe('PlatformAccountService: desativar e reativar conta (spec 045, E2)', () => {
  it('desativa com código: status, trilha com admin, sujeito e motivo; travas empresa antes de conta; revoga cookie e Bearer de cada vínculo depois do commit', async () => {
    const world = setup();
    const changed = await world.service.setStatus(
      ADMIN,
      world.accountId,
      'DISABLED',
      'ABUSE',
      CODE,
    );
    assert.equal(changed, true);
    assert.deepEqual(world.confirmCodes, [CODE]);
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'DISABLED');
    assert.equal(world.uow.accounts.get(world.other)?.status, 'ACTIVE');
    assert.equal(world.audit.events.length, 1);
    const event = world.audit.events[0];
    assert.equal(event?.action, 'ACCOUNT_DISABLED');
    assert.equal(event.adminId, ADMIN.adminId);
    assert.equal(event.subjectAccountId, world.accountId);
    assert.equal(event.subjectCompanyId, null);
    assert.equal(event.reason, 'ABUSE');
    assert.equal(world.uow.locks[0], `companies:${world.accountId}`);
    assert.equal(world.uow.locks[1], `account:${world.accountId}`);
    assert.deepEqual(world.calls, [
      `revokeAll:${world.accountId}:events=1`,
      ...bearerCalls(world, world.accountId),
    ]);
    assert.ok(
      !world.calls.some((call) => call.includes(world.other)),
      'a outra conta fica intacta',
    );
    assert.deepEqual(world.metrics, ['account_disabled']);
  });

  it('conta única dona ativa de empresa ativa: 409 LAST_OWNER, nada muda, nada é revogado', async () => {
    const world = setup();
    world.uow.soleOwner.set(world.accountId, 1);
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
      (error: unknown) => error instanceof ConflictError && error.code === 'LAST_OWNER',
    );
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
    assert.equal(world.audit.events.length, 0);
    assert.deepEqual(world.calls, []);
    assert.deepEqual(world.metrics, []);
  });

  it('com a empresa suspensa (nenhuma empresa ativa em que seja a única dona), desativa', async () => {
    const world = setup();
    // A consulta real só conta empresa ativa e não removida (integração); aqui a contagem é 0.
    world.uow.soleOwner.set(world.accountId, 0);
    assert.equal(
      await world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'PAYMENT', CODE),
      true,
    );
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'DISABLED');
  });

  it('sem código, com código errado ou já usado: 400 CONFIRMATION_INVALID, sem efeito; sem código nem consulta o autenticador', async () => {
    const world = setup();
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER'),
      (error: unknown) => error instanceof ValidationError && error.code === CONFIRMATION_INVALID,
    );
    assert.deepEqual(world.confirmCodes, []);
    world.confirmResult = Result.err({ reason: 'invalid_credentials' });
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
      (error: unknown) => error instanceof ValidationError && error.code === CONFIRMATION_INVALID,
    );
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
    assert.equal(world.audit.events.length, 0);
    assert.deepEqual(world.uow.locks, [], 'nem chegou à transação');
    assert.deepEqual(world.calls, []);
  });

  it('bloqueado por excesso de erros: 429 com Retry-After antes de conferir; autenticação fora: 503', async () => {
    const world = setup();
    world.confirmResult = Result.err({ reason: 'locked', retryAfterSeconds: 120 });
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
      (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 120,
    );
    world.confirmResult = Result.err({ reason: 'unavailable' });
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
      ServiceUnavailableError,
    );
    assert.equal(world.audit.events.length, 0);
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
  });

  it('repetir no mesmo estado: 204 sem novo evento, mas refaz a revogação', async () => {
    const world = setup();
    await world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE);
    world.calls.length = 0;
    const again = await world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE);
    assert.equal(again, false);
    assert.equal(world.audit.events.length, 1);
    assert.deepEqual(world.calls, [
      `revokeAll:${world.accountId}:events=1`,
      ...bearerCalls(world, world.accountId),
    ]);
    assert.deepEqual(world.metrics, ['account_disabled']);
  });

  it('Redis fora na revogação: 503 com a conta já desativada e a trilha gravada; repetir refaz só a revogação', async () => {
    const world = setup();
    world.redisDown = true;
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
      ServiceUnavailableError,
    );
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'DISABLED');
    assert.equal(world.audit.events.length, 1);
    world.redisDown = false;
    world.calls.length = 0;
    assert.equal(
      await world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
      false,
    );
    assert.equal(world.audit.events.length, 1, 'nenhum evento novo');
    assert.deepEqual(world.calls, [
      `revokeAll:${world.accountId}:events=1`,
      ...bearerCalls(world, world.accountId),
    ]);
    const logged = world.logs.lines().find((line) => line.reason === 'revocation_failed');
    assert.equal(logged?.accountId, world.accountId);
  });

  it('falha na gravação da trilha: o estado não muda e nada é revogado', async () => {
    const world = setup();
    world.uow.failAudit = true;
    await assert.rejects(
      world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'OTHER', CODE),
    );
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
    assert.deepEqual(world.calls, []);
    await assert.rejects(world.service.setStatus(ADMIN, world.other, 'DISABLED', 'OTHER', CODE));
    world.uow.accounts.set(world.other, { status: 'DISABLED', verified: false });
    await assert.rejects(world.service.setStatus(ADMIN, world.other, 'ACTIVE', 'OTHER'));
    assert.equal(world.uow.accounts.get(world.other)?.status, 'DISABLED');
  });

  it('reativar: sem código, trilha ACCOUNT_ENABLED, sem revogar nem mexer em vínculos; idempotente', async () => {
    const world = setup();
    world.uow.accounts.set(world.accountId, { status: 'DISABLED', verified: true });
    assert.equal(
      await world.service.setStatus(ADMIN, world.accountId, 'ACTIVE', 'OWNER_REQUEST'),
      true,
    );
    assert.deepEqual(world.confirmCodes, []);
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
    assert.deepEqual(
      world.audit.events.map((event) => [event.action, event.reason]),
      [['ACCOUNT_ENABLED', 'OWNER_REQUEST']],
    );
    assert.deepEqual(
      world.uow.locks,
      [`account:${world.accountId}`],
      'reativar não trava empresas',
    );
    assert.deepEqual(world.calls, []);
    assert.equal(
      await world.service.setStatus(ADMIN, world.accountId, 'ACTIVE', 'OWNER_REQUEST'),
      false,
    );
    assert.equal(world.audit.events.length, 1);
    assert.deepEqual(world.metrics, ['account_enabled']);
  });

  it('id malformado: 404 sem consultar o autenticador; inexistente: 404 sem gravar', async () => {
    const world = setup();
    await assert.rejects(
      world.service.setStatus(ADMIN, 'nao-uuid', 'DISABLED', 'OTHER', CODE),
      NotFoundError,
    );
    assert.deepEqual(world.confirmCodes, []);
    for (const target of ['DISABLED', 'ACTIVE'] as const) {
      await assert.rejects(
        world.service.setStatus(ADMIN, randomUUID(), target, 'OTHER', CODE),
        NotFoundError,
      );
    }
    for (const call of [
      world.service.revokeSessions(ADMIN, randomUUID(), 'OTHER'),
      world.service.sendPasswordReset(ADMIN, randomUUID(), 'OTHER'),
      world.service.resendVerification(ADMIN, randomUUID(), 'OTHER'),
      world.service.revokeSessions(ADMIN, 'x', 'OTHER'),
    ]) {
      await assert.rejects(call, NotFoundError);
    }
    assert.equal(world.audit.events.length, 0);
    assert.deepEqual(world.calls, []);
  });
});

describe('PlatformAccountService: sessões, recuperação e confirmação (spec 045, E2)', () => {
  it('encerrar sessões: trilha gravada antes; depois revokeAll e as Bearer dos vínculos da conta', async () => {
    const world = setup();
    await world.service.revokeSessions(ADMIN, world.accountId, 'OWNER_REQUEST');
    assert.deepEqual(
      world.audit.events.map((event) => [event.action, event.subjectAccountId, event.reason]),
      [['ACCOUNT_SESSIONS_REVOKED', world.accountId, 'OWNER_REQUEST']],
    );
    assert.deepEqual(world.calls, [
      `revokeAll:${world.accountId}:events=1`,
      ...bearerCalls(world, world.accountId),
    ]);
    assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
    world.redisDown = true;
    await assert.rejects(
      world.service.revokeSessions(ADMIN, world.accountId, 'OTHER'),
      ServiceUnavailableError,
    );
    assert.equal(world.audit.events.length, 2, 'a trilha fica, a revogação não é transacional');
    assert.deepEqual(world.metrics, ['account_sessions_revoked', 'account_sessions_revoked']);
  });

  it('código de recuperação: trilha e depois o caminho da 021 pelo id; o serviço nunca vê o e-mail', async () => {
    const world = setup();
    await world.service.sendPasswordReset(ADMIN, world.accountId, 'OWNER_REQUEST');
    assert.deepEqual(
      world.audit.events.map((event) => event.action),
      ['ACCOUNT_PASSWORD_RESET_SENT'],
    );
    assert.deepEqual(world.calls, [`reset:${world.accountId}:events=1`]);
    // Conta desativada também gera a trilha (pedido aceito pela validação); a 021 não envia nada.
    world.uow.accounts.set(world.other, { status: 'DISABLED', verified: true });
    await world.service.sendPasswordReset(ADMIN, world.other, 'OTHER');
    assert.equal(world.audit.events.length, 2);
    assert.deepEqual(world.metrics, ['account_password_reset_sent', 'account_password_reset_sent']);
  });

  it('reenviar confirmação: conta confirmada = 409 ALREADY_VERIFIED sem trilha nem envio; não confirmada = trilha e reenvio', async () => {
    const world = setup();
    await assert.rejects(
      world.service.resendVerification(ADMIN, world.accountId, 'OTHER'),
      (error: unknown) => error instanceof ConflictError && error.code === 'ALREADY_VERIFIED',
    );
    assert.equal(world.audit.events.length, 0);
    assert.deepEqual(world.calls, []);
    await world.service.resendVerification(ADMIN, world.other, 'OWNER_REQUEST');
    assert.deepEqual(
      world.audit.events.map((event) => [event.action, event.subjectAccountId]),
      [['ACCOUNT_VERIFICATION_SENT', world.other]],
    );
    assert.deepEqual(world.calls, [`verify:${world.other}:events=1`]);
    assert.deepEqual(world.metrics, ['account_verification_sent']);
  });

  it('o log leva só ids, ação e motivo', async () => {
    const world = setup();
    await world.service.setStatus(ADMIN, world.accountId, 'DISABLED', 'ABUSE', CODE);
    await world.service.sendPasswordReset(ADMIN, world.accountId, 'OTHER');
    const line = world.logs.lines().find((entry) => entry.action === 'ACCOUNT_DISABLED');
    assert.equal(line?.adminId, ADMIN.adminId);
    assert.equal(line.accountId, world.accountId);
    assert.equal(line.reason, 'ABUSE');
    assert.ok(!world.logs.raw().includes('@'), 'nenhum e-mail');
    assert.ok(!world.logs.raw().includes(CODE), 'nenhum código');
  });
});
