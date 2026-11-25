import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import type { InvitationUnitOfWork } from '../../application/ports/invitation-unit-of-work.js';
import { PlatformAdminId } from '../../domain/index.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { logContains } from '../../test-support/log-capture.js';
import {
  createInvitationWorld,
  errorOf,
  PASSWORD,
  tokenOf,
  type InvitationWorld,
} from '../../test-support/invitation-world.js';

// Spec 045, E3b: o convite da plataforma e "Nova empresa" com Postgres (soprei_test) e Redis (/15) reais,
// pelo mesmo InvitationService da 025 (token, cotas, e-mail falso) e pelas rotas públicas de aceite.

let w: InvitationWorld;
let admin: PlatformIdentity;
const createdAdmins: string[] = [];
const reason = 'OWNER_REQUEST' as const;

async function newAdmin(): Promise<PlatformIdentity> {
  const row = await w.db.prisma.platformAdmin.create({
    data: { email: `adm-e3b-${randomUUID()}@exemplo.test`, passwordHash: 'x' },
  });
  createdAdmins.push(row.id);
  return { kind: 'platform', adminId: PlatformAdminId.parse(row.id), sessionId: randomUUID() };
}

async function platformEvents(companyId: string) {
  return w.db.prisma.platformAuditEvent.findMany({
    where: { subjectCompanyId: companyId },
    orderBy: { createdAt: 'asc' },
    select: { action: true, subjectInvitationId: true, toRole: true, reason: true },
  });
}

async function membershipOf(companyId: string, accountId: string) {
  return w.db.prisma.membership.findFirst({
    where: { companyId, accountId },
    select: { role: true, status: true },
  });
}

async function lastMailTo(email: string) {
  await w.invitations.drain();
  return w.sent.filter((entry) => entry.email === email).at(-1);
}

before(async () => {
  w = await createInvitationWorld('platform-invites-e3b');
  admin = await newAdmin();
});

after(async () => {
  await w.invitations.drain();
  // A trilha da plataforma aponta para convites e admins e os convites para os admins (RESTRICT): trilha,
  // depois empresas e convites, depois os admins, e só então o resto do mundo.
  await w.db.prisma.platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
  await w.tenants.cleanup();
  await w.db.prisma.platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
  await w.close();
});

describe('convite da plataforma e "Nova empresa" com Postgres e Redis reais (spec 045, E3b)', () => {
  it('convite de OWNER aceito por conta existente (mesmo e-mail) cria o vínculo de dono; trilha só da plataforma', async () => {
    const { company } = await w.setup('Empresa E3b A');
    const person = await w.signUp('futuro-dono');
    const view = await w.invitations.createByPlatform(
      admin,
      company,
      { email: person.email, role: 'OWNER' },
      reason,
    );
    assert.equal(view.role, 'OWNER');
    assert.equal(view.invitedBy, 'platform');
    assert.match(view.emailMasked, /^.\*\*\*@invites\.test$/);
    const mail = await lastMailTo(person.email);
    assert.equal(mail?.mail.role, 'OWNER');
    const row = await w.db.prisma.companyInvitation.findFirst({
      where: { id: view.id, companyId: company },
      select: { invitedByAdminId: true, invitedByMembershipId: true },
    });
    assert.deepEqual(row, { invitedByAdminId: admin.adminId, invitedByMembershipId: null });

    const accepted = await w.request('POST', '/auth/invitations/accept', {
      cookie: person.cookie,
      payload: { token: tokenOf(mail) },
    });
    assert.equal(accepted.statusCode, 204, accepted.body);
    assert.deepEqual(await membershipOf(company, person.accountId), {
      role: 'OWNER',
      status: 'ACTIVE',
    });
    assert.deepEqual(await platformEvents(company), [
      {
        action: 'INVITATION_CREATED_BY_PLATFORM',
        subjectInvitationId: view.id,
        toRole: 'OWNER',
        reason,
      },
    ]);
    // A trilha da EMPRESA não ganha o convite da plataforma (D9); o aceite é da empresa (025).
    const companyAudit = await w.db.prisma.auditEvent.findMany({
      where: { companyId: company, invitationId: view.id },
      select: { action: true },
    });
    assert.deepEqual(companyAudit, [{ action: 'INVITATION_ACCEPTED' }]);
  });

  it('pessoa nova aceita pelo accept-new com o papel pedido', async () => {
    const { company } = await w.setup('Empresa E3b B');
    const email = w.freshEmail('novo-atendente');
    await w.invitations.createByPlatform(admin, company, { email, role: 'AGENT' }, reason);
    const mail = await lastMailTo(email);
    const response = await w.request('POST', '/auth/invitations/accept-new', {
      payload: { token: tokenOf(mail), password: PASSWORD },
    });
    assert.equal(response.statusCode, 204, response.body);
    const account = await w.accountRepository.findByEmail(email);
    assert.ok(account);
    assert.deepEqual(await membershipOf(company, account.id), { role: 'AGENT', status: 'ACTIVE' });
  });

  it('admin desativado entre o convite e o aceite: falha uniforme e o convite fecha como REVOKED', async () => {
    const other = await newAdmin();
    const { company } = await w.setup('Empresa E3b C');
    const email = w.freshEmail('convidado-orfao');
    const view = await w.invitations.createByPlatform(
      other,
      company,
      { email, role: 'ADMIN' },
      reason,
    );
    const mail = await lastMailTo(email);
    await w.db.prisma.platformAdmin.updateMany({
      where: { id: other.adminId },
      data: { status: 'DISABLED' },
    });
    const response = await w.request('POST', '/auth/invitations/accept-new', {
      payload: { token: tokenOf(mail), password: PASSWORD },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorOf(response).code, 'INVITATION_INVALID');
    const row = await w.db.prisma.companyInvitation.findFirst({
      where: { id: view.id, companyId: company },
      select: { status: true, email: true },
    });
    assert.deepEqual(row, { status: 'REVOKED', email: null });
  });

  it('regras da 025: membro existente, pendente repetido, empresa suspensa (COMPANY_INACTIVE) e empresa inexistente', async () => {
    const { owner, company } = await w.setup('Empresa E3b D');
    await assert.rejects(
      w.invitations.createByPlatform(admin, company, { email: owner.email, role: 'ADMIN' }, reason),
      (error: unknown) => error instanceof ConflictError && error.code === 'MEMBER_ALREADY_EXISTS',
    );
    const email = w.freshEmail('repetido');
    await w.invitations.createByPlatform(admin, company, { email, role: 'VIEWER' }, reason);
    await assert.rejects(
      w.invitations.createByPlatform(admin, company, { email, role: 'VIEWER' }, reason),
      (error: unknown) =>
        error instanceof ConflictError && error.code === 'INVITATION_ALREADY_PENDING',
    );
    await w.db.prisma.company.updateMany({ where: { id: company }, data: { status: 'SUSPENDED' } });
    await assert.rejects(
      w.invitations.createByPlatform(
        admin,
        company,
        { email: w.freshEmail('suspensa'), role: 'AGENT' },
        reason,
      ),
      (error: unknown) => error instanceof ConflictError && error.code === 'COMPANY_INACTIVE',
    );
    await assert.rejects(
      w.invitations.createByPlatform(
        admin,
        randomUUID(),
        { email: w.freshEmail('x'), role: 'AGENT' },
        reason,
      ),
      NotFoundError,
    );
  });

  it('reenviar e revogar qualquer convite pendente da empresa (inclusive o feito pela equipe); de outra empresa = 404', async () => {
    const { owner, company } = await w.setup('Empresa E3b E');
    const { company: otherCompany } = await w.setup('Empresa E3b E2');
    const email = w.freshEmail('da-equipe');
    const { item } = await w.inviteOk(owner, company, email);
    await assert.rejects(
      w.invitations.revokeByPlatform(admin, otherCompany, item.id, reason),
      NotFoundError,
    );
    w.control.offsetMs = 61_000;
    try {
      const resent = await w.invitations.resendByPlatform(admin, company, item.id, reason);
      assert.equal(resent.sendCount, 2);
      assert.equal(resent.invitedBy, 'membership');
    } finally {
      w.control.offsetMs = 0;
    }
    await w.invitations.revokeByPlatform(admin, company, item.id, reason);
    // Repetir a revogação: sem evento novo.
    await w.invitations.revokeByPlatform(admin, company, item.id, reason);
    assert.deepEqual(
      (await platformEvents(company)).map((event) => event.action),
      ['INVITATION_RESENT_BY_PLATFORM', 'INVITATION_REVOKED_BY_PLATFORM'],
    );
    const listed = await w.invitations.listForCompany(company);
    assert.ok(!listed.items.some((entry) => entry.id === item.id));
  });

  it('a empresa vê o convite da plataforma (fromPlatform) e pode revogá-lo, mas não reenviá-lo (revisão da E3b, I1)', async () => {
    const { owner, company } = await w.setup('Empresa E3b G');
    const email = w.freshEmail('dono-pela-plataforma');
    const view = await w.invitations.createByPlatform(
      admin,
      company,
      { email, role: 'OWNER' },
      reason,
    );
    const list = await w.request('GET', `/admin/companies/${company}/invitations`, {
      cookie: owner.cookie,
    });
    assert.equal(list.statusCode, 200, list.body);
    const items = list.json<{ items: { id: string; role: string; fromPlatform: boolean }[] }>()
      .items;
    assert.deepEqual(
      items.map((item) => [item.id, item.role, item.fromPlatform]),
      [[view.id, 'OWNER', true]],
    );
    w.control.offsetMs = 61_000;
    try {
      const resend = await w.request(
        'POST',
        `/admin/companies/${company}/invitations/${view.id}/resend`,
        { cookie: owner.cookie, payload: {} },
      );
      assert.equal(resend.statusCode, 403);
      assert.equal(errorOf(resend).code, 'INVITATION_FROM_PLATFORM');
    } finally {
      w.control.offsetMs = 0;
    }
    const row = await w.db.prisma.companyInvitation.findFirst({
      where: { id: view.id, companyId: company },
      select: { sendCount: true, status: true },
    });
    assert.deepEqual(row, { sendCount: 1, status: 'PENDING' });
    const revoke = await w.request('DELETE', `/admin/companies/${company}/invitations/${view.id}`, {
      cookie: owner.cookie,
    });
    assert.equal(revoke.statusCode, 204);
  });

  it('trilha recusada em convidar, reenviar e revogar pela plataforma: nada muda (rollback real)', async () => {
    const real = w.unitOfWork;
    const broken: InvitationUnitOfWork = {
      run: (fn) =>
        real.run((tx) =>
          fn({ ...tx, platformAudit: () => Promise.reject(new Error('trilha indisponível')) }),
        ),
    };
    const service = w.buildInvitations({ unitOfWork: broken });
    const { company } = await w.setup('Empresa E3b H');
    const blocked = w.freshEmail('sem-trilha');
    await assert.rejects(
      service.createByPlatform(admin, company, { email: blocked, role: 'AGENT' }, reason),
    );
    assert.equal(
      await w.db.prisma.companyInvitation.count({ where: { companyId: company, email: blocked } }),
      0,
    );
    const view = await w.invitations.createByPlatform(
      admin,
      company,
      { email: w.freshEmail('com-trilha'), role: 'AGENT' },
      reason,
    );
    w.control.offsetMs = 61_000;
    try {
      await assert.rejects(service.resendByPlatform(admin, company, view.id, reason));
    } finally {
      w.control.offsetMs = 0;
    }
    await assert.rejects(service.revokeByPlatform(admin, company, view.id, reason));
    const row = await w.db.prisma.companyInvitation.findFirst({
      where: { id: view.id, companyId: company },
      select: { sendCount: true, status: true },
    });
    assert.deepEqual(row, { sendCount: 1, status: 'PENDING' });
  });

  it('"Nova empresa" grava a empresa e o convite de OWNER na mesma transação; slug repetido (inclusive de removida) = 409 SLUG_TAKEN', async () => {
    const slug = `e3b-${randomUUID().slice(0, 8)}`;
    const ownerEmail = w.freshEmail('dono-novo');
    const created = await w.invitations.createCompanyWithOwner(
      admin,
      { name: 'Padaria Nova E3b', slug, ownerEmail },
      reason,
    );
    w.tenants.track(created.companyId);
    const company = await w.db.prisma.company.findFirst({
      where: { id: created.companyId },
      select: { status: true, slug: true, subscriptionId: true },
    });
    assert.deepEqual(company, { status: 'ACTIVE', slug, subscriptionId: null });
    assert.equal(created.invitation.role, 'OWNER');
    assert.deepEqual(
      (await platformEvents(created.companyId)).map((event) => event.action).sort(),
      ['COMPANY_CREATED', 'INVITATION_CREATED_BY_PLATFORM'],
    );
    const mail = await lastMailTo(ownerEmail);
    const accepted = await w.request('POST', '/auth/invitations/accept-new', {
      payload: { token: tokenOf(mail), password: PASSWORD },
    });
    assert.equal(accepted.statusCode, 204, accepted.body);
    const account = await w.accountRepository.findByEmail(ownerEmail);
    assert.ok(account);
    assert.deepEqual(await membershipOf(created.companyId, account.id), {
      role: 'OWNER',
      status: 'ACTIVE',
    });

    // Slug repetido, também depois de a empresa ser removida (fica reservado).
    await w.db.prisma.company.updateMany({
      where: { id: created.companyId },
      data: { deletedAt: new Date() },
    });
    await assert.rejects(
      w.invitations.createCompanyWithOwner(
        admin,
        { name: 'Outra', slug, ownerEmail: w.freshEmail('outro-dono') },
        reason,
      ),
      (error: unknown) => error instanceof ConflictError && error.code === 'SLUG_TAKEN',
    );
    assert.equal(await w.db.prisma.company.count({ where: { slug } }), 1);
  });

  it('falha no convite (trilha recusada) = nenhuma empresa criada', async () => {
    const real = w.unitOfWork;
    const broken: InvitationUnitOfWork = {
      run: (fn) =>
        real.run((tx) =>
          fn({
            ...tx,
            platformAudit: (event) =>
              event.action === 'INVITATION_CREATED_BY_PLATFORM'
                ? Promise.reject(new Error('trilha indisponível'))
                : tx.platformAudit(event),
          }),
        ),
    };
    const service = w.buildInvitations({ unitOfWork: broken });
    const slug = `e3b-f-${randomUUID().slice(0, 8)}`;
    await assert.rejects(
      service.createCompanyWithOwner(
        admin,
        { name: 'Não nasce', slug, ownerEmail: w.freshEmail('nao-nasce') },
        reason,
      ),
    );
    assert.equal(await w.db.prisma.company.count({ where: { slug } }), 0);
  });

  it('privacidade: nenhum e-mail de convidado, token, link ou nome de empresa no log nem no /metrics', async () => {
    const raw = w.logs.raw();
    const metrics = await w.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${'m'.repeat(32)}` },
    });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.body, /action="invitation_created_by_platform"/);
    for (const entry of w.sent) {
      for (const secret of [entry.email, entry.mail.link, entry.mail.companyName]) {
        assert.ok(!logContains(raw, secret), 'no log');
        assert.ok(!metrics.body.includes(secret), 'no /metrics');
      }
    }
  });
});
