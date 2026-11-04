import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { INVITATION_INVALID_MESSAGE } from '../../application/invitations/invitation.service.js';
import { CompanyId, INVITATION_MAX_PENDING, MembershipId } from '../../domain/index.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import {
  createInvitationWorld,
  errorOf,
  type InvitationWorld,
  tokenOf,
} from '../../test-support/invitation-world.js';

// Spec 025: criar, listar, reenviar e revogar convites, permissões, hierarquia, cotas, e-mail e
// isolamento. Servidor real com Postgres e Redis reais (soprei_test e /15); e-mail falso.
let w: InvitationWorld;
before(async () => {
  w = await createInvitationWorld('inv-manage');
});

after(async () => {
  await w.close();
});

const UNIFORM = { code: 'INVITATION_INVALID', message: INVITATION_INVALID_MESSAGE };

const preview = (token: string) =>
  w.request('POST', '/auth/invitations/preview', { payload: { token } });

/** Um papel novo na empresa, com a pessoa já logada e a empresa selecionada. */
async function member(name: string, company: string, role: 'ADMIN' | 'AGENT' | 'VIEWER' | 'OWNER') {
  const person = await w.signUp(name);
  const membershipId = await w.join(person, company, role);
  return { person, membershipId };
}

describe('criar convite: permissão, hierarquia e papéis', () => {
  it('OWNER convida ADMIN, AGENT e VIEWER (201), a lista os mostra e o e-mail sai com o link do fragmento', async () => {
    const { owner, company } = await w.setup('Empresa dos papéis');
    const created: { id: string; email: string; role: string }[] = [];
    for (const role of ['ADMIN', 'AGENT', 'VIEWER']) {
      const email = w.freshEmail(role.toLowerCase());
      const { item, token, mail } = await w.inviteOk(owner, company, email, role);
      assert.equal(item.role, role);
      assert.equal(item.sendCount, 1);
      assert.ok(token);
      // O corpo da resposta nunca traz o hash nem o segredo.
      assert.deepEqual(Object.keys(item).sort(), [
        'createdAt',
        'email',
        'expiresAt',
        'id',
        'lastSentAt',
        'role',
        'sendCount',
        'state',
      ]);
      assert.equal(mail?.mail.role, role);
      assert.equal(mail.mail.validDays, 7);
      assert.match(mail.mail.link, /^http:\/\/localhost:5174\/convite#t=[^?]+$/);
      assert.ok(token.startsWith(`${company}.${item.id}.`));
      created.push(item);
    }
    const list = await w.request('GET', `/admin/companies/${company}/invitations`, {
      cookie: owner.cookie,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    const items = list.json<{ items: { id: string; state: string }[]; nextCursor: null }>().items;
    assert.deepEqual(items.map((i) => i.id).sort(), created.map((i) => i.id).sort());
    assert.ok(items.every((i) => i.state === 'PENDING'));
  });

  it('ADMIN convida AGENT e VIEWER mas não ADMIN; OWNER não é convidável (400) e AGENT/VIEWER recebem 403', async () => {
    const { owner, company } = await w.setup('Empresa da hierarquia');
    const admin = await member('adm', company, 'ADMIN');
    const agent = await member('agt', company, 'AGENT');
    const viewer = await member('vwr', company, 'VIEWER');
    assert.equal(
      (await w.invite(admin.person, company, w.freshEmail('x'), 'AGENT')).statusCode,
      201,
    );
    assert.equal(
      (await w.invite(admin.person, company, w.freshEmail('x'), 'VIEWER')).statusCode,
      201,
    );
    assert.equal(
      (await w.invite(admin.person, company, w.freshEmail('x'), 'ADMIN')).statusCode,
      403,
    );
    for (const who of [owner, admin.person]) {
      const response = await w.invite(who, company, w.freshEmail('x'), 'OWNER');
      assert.equal(response.statusCode, 400);
      assert.equal(errorOf(response).code, 'VALIDATION_ERROR');
    }
    for (const who of [agent.person, viewer.person]) {
      assert.equal((await w.invite(who, company, w.freshEmail('x'), 'VIEWER')).statusCode, 403);
      assert.equal(
        (await w.request('GET', `/admin/companies/${company}/invitations`, { cookie: who.cookie }))
          .statusCode,
        403,
      );
    }
  });

  it(':companyId de outra empresa é 404 antes do 403, mesmo para quem não tem permissão', async () => {
    const { company } = await w.setup('Empresa do 404');
    const agent = await member('agt404', company, 'AGENT');
    const other = await w.signUp('estranho');
    const otherCompany = await w.createCompany(other, 'Empresa do estranho');
    // O AGENT de `company` chama o caminho de `otherCompany`: 404 (não 403) e nada é gravado.
    const response = await w.invite(agent.person, otherCompany, w.freshEmail('x'));
    assert.equal(response.statusCode, 404);
    assert.equal(
      (
        await w.request('GET', `/admin/companies/${otherCompany}/invitations`, {
          cookie: agent.person.cookie,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      await w.db.prisma.companyInvitation.count({ where: { companyId: otherCompany } }),
      0,
    );
  });

  it('o convidador é relido do banco: rebaixado perde a permissão e desativado perde o acesso, com o cookie ainda válido', async () => {
    const { company } = await w.setup('Empresa do rebaixamento');
    const admin = await member('reb', company, 'ADMIN');
    assert.equal(
      (await w.invite(admin.person, company, w.freshEmail('x'), 'AGENT')).statusCode,
      201,
    );
    await w.db.prisma.membership.updateMany({
      where: { companyId: company, id: admin.membershipId },
      data: { role: 'AGENT' },
    });
    assert.equal(
      (await w.invite(admin.person, company, w.freshEmail('x'), 'AGENT')).statusCode,
      403,
    );
    await w.db.prisma.membership.updateMany({
      where: { companyId: company, id: admin.membershipId },
      data: { role: 'ADMIN', status: 'DISABLED' },
    });
    assert.equal(
      (await w.invite(admin.person, company, w.freshEmail('x'), 'AGENT')).statusCode,
      401,
    );
  });

  it('exige Origin e X-Soprei-App (403), recusa campo extra (400) e papel desconhecido (400)', async () => {
    const { owner, company } = await w.setup('Empresa do CSRF');
    const url = `/admin/companies/${company}/invitations`;
    const payload = { email: w.freshEmail('x'), role: 'AGENT' };
    const noHeaders = await w.app.inject({
      method: 'POST',
      url,
      headers: { cookie: owner.cookie },
      payload,
    });
    assert.equal(noHeaders.statusCode, 403);
    const extra = await w.request('POST', url, {
      cookie: owner.cookie,
      payload: { ...payload, extra: 1 },
    });
    assert.equal(extra.statusCode, 400);
    const unknown = await w.request('POST', url, {
      cookie: owner.cookie,
      payload: { ...payload, role: 'ROOT' },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(await w.db.prisma.companyInvitation.count({ where: { companyId: company } }), 0);
  });
});

describe('sem enumeração de contas ao criar', () => {
  it('a resposta é idêntica para e-mail com conta confirmada, não confirmada, sem conta e com conta em outra empresa; o código não consulta contas', async () => {
    const { owner, company } = await w.setup('Empresa da enumeração');
    const confirmed = await w.signUp('confirmada');
    const inOtherCompany = await w.signUp('outra');
    await w.createCompany(inOtherCompany, 'Outra empresa');
    const unconfirmedEmail = w.freshEmail('naoconf');
    assert.equal(
      (
        await w.request('POST', '/auth/register', {
          payload: { email: unconfirmedEmail, password: 'Secret1-forte' },
        })
      ).statusCode,
      202,
    );
    const targets = [
      confirmed.email,
      unconfirmedEmail,
      w.freshEmail('semconta'),
      inOtherCompany.email,
    ];
    const lookups = w.control.accountLookups;
    const shapes: unknown[] = [];
    for (const email of targets) {
      const response = await w.invite(owner, company, email);
      assert.equal(response.statusCode, 201);
      const body = response.json<Record<string, unknown>>();
      shapes.push({
        status: response.statusCode,
        contentType: response.headers['content-type'],
        cache: response.headers['cache-control'],
        keys: Object.keys(body).sort(),
        role: body.role,
        state: body.state,
        sendCount: body.sendCount,
      });
    }
    await w.invitations.drain();
    assert.equal(new Set(shapes.map((shape) => JSON.stringify(shape))).size, 1);
    assert.equal(w.control.accountLookups, lookups, 'o create não consulta a tabela de contas');
  });
});

describe('recusas visíveis só a quem gerencia', () => {
  it('e-mail de membro (ativo ou desativado) é 409 MEMBER_ALREADY_EXISTS; pendente é 409 INVITATION_ALREADY_PENDING; e-mail é normalizado', async () => {
    const { owner, company } = await w.setup('Empresa das recusas');
    const active = await member('ativo', company, 'AGENT');
    const disabled = await member('inativo', company, 'VIEWER');
    await w.db.prisma.membership.updateMany({
      where: { companyId: company, id: disabled.membershipId },
      data: { status: 'DISABLED' },
    });
    for (const person of [active.person, disabled.person]) {
      const response = await w.invite(owner, company, person.email.toUpperCase());
      assert.equal(response.statusCode, 409);
      assert.equal(errorOf(response).code, 'MEMBER_ALREADY_EXISTS');
    }
    const email = w.freshEmail('pend');
    assert.equal((await w.invite(owner, company, email)).statusCode, 201);
    for (const variant of [email, `  ${email.toUpperCase()}  `]) {
      const again = await w.invite(owner, company, variant);
      assert.equal(again.statusCode, 409);
      assert.equal(errorOf(again).code, 'INVITATION_ALREADY_PENDING');
    }
  });

  it('pendente VENCIDO é fechado (e-mail e hash anulados) e o novo convite entra no lugar', async () => {
    const { owner, company } = await w.setup('Empresa do vencido');
    const email = w.freshEmail('venc');
    const first = await w.inviteOk(owner, company, email);
    w.control.offsetMs = 8 * 24 * 60 * 60_000;
    try {
      const second = await w.invite(owner, company, email);
      assert.equal(second.statusCode, 201);
      await w.invitations.drain();
    } finally {
      w.control.offsetMs = 0;
    }
    const closed = await w.db.prisma.companyInvitation.findFirst({
      where: { id: first.item.id, companyId: company },
    });
    assert.equal(closed?.status, 'EXPIRED');
    assert.equal(closed.email, null);
    assert.equal(closed.tokenHash, null);
    assert.equal(
      await w.db.prisma.companyInvitation.count({
        where: { companyId: company, status: 'PENDING' },
      }),
      1,
    );
  });
});

describe('cotas anti-spam', () => {
  it('o 21º convite pendente da empresa é 429 INVITATION_LIMIT_REACHED, e a cota de uma empresa não consome a da outra', async () => {
    const { owner, company } = await w.setup('Empresa dos pendentes');
    const other = await w.createCompany(owner, 'Empresa vizinha dos pendentes');
    await w.select(owner, company);
    for (let index = 0; index < INVITATION_MAX_PENDING; index += 1) {
      assert.equal((await w.invite(owner, company, w.freshEmail('p'))).statusCode, 201);
    }
    const over = await w.invite(owner, company, w.freshEmail('p'));
    assert.equal(over.statusCode, 429);
    assert.equal(errorOf(over).code, 'INVITATION_LIMIT_REACHED');
    assert.ok(Number(over.headers['retry-after']) >= 1);
    // A outra empresa (mesmo convidador) segue livre pelo teto de pendentes dela.
    await w.select(owner, other);
    assert.equal((await w.invite(owner, other, w.freshEmail('p'))).statusCode, 201);
    await w.invitations.drain();
  });

  it('o 21º envio do mesmo convidador em 24 h é 429, mesmo com poucos pendentes (revogados contam)', async () => {
    const { owner, company } = await w.setup('Empresa do convidador');
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const created = await w.invite(owner, company, w.freshEmail('c'));
      assert.equal(created.statusCode, 201);
      ids.push(created.json<{ id: string }>().id);
    }
    for (const id of ids) {
      assert.equal(
        (
          await w.request('DELETE', `/admin/companies/${company}/invitations/${id}`, {
            cookie: owner.cookie,
          })
        ).statusCode,
        204,
      );
    }
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await w.invite(owner, company, w.freshEmail('c'))).statusCode, 201);
    }
    const over = await w.invite(owner, company, w.freshEmail('c'));
    assert.equal(over.statusCode, 429);
    assert.equal(errorOf(over).code, 'INVITATION_LIMIT_REACHED');
    await w.invitations.drain();
  });

  it('o 31º envio da empresa em 24 h é 429 mesmo com outro convidador que está dentro do próprio teto', async () => {
    const { owner, company } = await w.setup('Empresa dos 30 envios');
    const admin = await member('trinta', company, 'ADMIN');
    const mine: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const created = await w.invite(owner, company, w.freshEmail('t'));
      assert.equal(created.statusCode, 201);
      mine.push(created.json<{ id: string }>().id);
    }
    for (const id of mine.slice(0, 10)) {
      await w.request('DELETE', `/admin/companies/${company}/invitations/${id}`, {
        cookie: owner.cookie,
      });
    }
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await w.invite(admin.person, company, w.freshEmail('t'))).statusCode, 201);
    }
    const over = await w.invite(admin.person, company, w.freshEmail('t'));
    assert.equal(over.statusCode, 429);
    assert.equal(errorOf(over).code, 'INVITATION_LIMIT_REACHED');
    await w.invitations.drain();
  });

  it('concorrência: 40 criações simultâneas na mesma empresa gravam exatamente o limite', async () => {
    const { owner, company } = await w.setup('Empresa da concorrência');
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => w.invite(owner, company, w.freshEmail('k'))),
    );
    const created = responses.filter((r) => r.statusCode === 201).length;
    const limited = responses.filter((r) => r.statusCode === 429).length;
    assert.equal(created, INVITATION_MAX_PENDING);
    assert.equal(created + limited, 40);
    assert.equal(
      await w.db.prisma.companyInvitation.count({
        where: { companyId: company, status: 'PENDING' },
      }),
      INVITATION_MAX_PENDING,
    );
    await w.invitations.drain();
  });

  it('dois convites simultâneos ao mesmo e-mail e empresa gravam exatamente um (o outro é 409)', async () => {
    const { owner, company } = await w.setup('Empresa do e-mail repetido');
    for (let round = 0; round < 5; round += 1) {
      const email = w.freshEmail('dupla');
      const [a, b] = await Promise.all([
        w.invite(owner, company, email),
        w.invite(owner, company, email),
      ]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409], `rodada ${String(round)}`);
    }
    await w.invitations.drain();
  });

  it('cota por destinatário entre empresas: 3 e-mails por dia; o 4º convite é gravado com a MESMA resposta, sem envio', async () => {
    const email = w.freshEmail('alvo');
    const companies: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const dono = await w.signUp(`dono${String(index)}`);
      companies.push(await w.createCompany(dono, `Empresa do alvo ${String(index)}`));
      const before = w.sent.length;
      const response = await w.invite(dono, companies[index] ?? '', email);
      assert.equal(response.statusCode, 201);
      await w.invitations.drain();
      const mailed = w.sent.length - before;
      assert.equal(mailed, index < 3 ? 1 : 0, `convite ${String(index + 1)}`);
      assert.equal(response.json<{ state: string }>().state, 'PENDING');
    }
    // O convite do 4º ficou gravado (o gerenciador pode reenviar depois).
    assert.equal(
      await w.db.prisma.companyInvitation.count({
        where: { companyId: companies[3] ?? '', status: 'PENDING' },
      }),
      1,
    );
  });

  it('Redis das cotas fora é 503 antes de gravar', async () => {
    const { owner, company } = await w.setup('Empresa do Redis fora');
    w.control.quotaDown = true;
    try {
      const response = await w.invite(owner, company, w.freshEmail('x'));
      assert.equal(response.statusCode, 503);
    } finally {
      w.control.quotaDown = false;
    }
    assert.equal(await w.db.prisma.companyInvitation.count({ where: { companyId: company } }), 0);
  });
});

describe('e-mail do convite', () => {
  it('falha do SMTP não muda a resposta (201), não apaga o convite e vai só à métrica e ao log', async () => {
    const { owner, company } = await w.setup('Empresa do SMTP');
    w.control.mailerFails = true;
    try {
      const email = w.freshEmail('smtp');
      const response = await w.invite(owner, company, email);
      assert.equal(response.statusCode, 201);
      await w.invitations.drain();
      const row = await w.db.prisma.companyInvitation.findFirst({
        where: { id: response.json<{ id: string }>().id, companyId: company },
      });
      assert.equal(row?.status, 'PENDING');
      assert.equal(row.email, email);
      assert.match(
        await w.metrics.render(),
        /company_invitation_emails_total\{result="failed"\} \d+/,
      );
      assert.ok(
        w.logs
          .lines()
          .some((line) => line.msg === 'falha ao enviar o convite' && line.result === 'failed'),
      );
    } finally {
      w.control.mailerFails = false;
    }
  });

  it('nenhum envio dentro da transação e o drain espera o envio pendente', async () => {
    const { owner, company } = await w.setup('Empresa do drain');
    let release: () => void = () => undefined;
    w.control.mailerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = w.sent.length;
    const email = w.freshEmail('drain');
    const response = await w.invite(owner, company, email);
    // A resposta saiu com o convite gravado e o envio ainda segurado.
    assert.equal(response.statusCode, 201);
    assert.equal(w.sent.length, before);
    let drained = false;
    const draining = w.invitations.drain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(drained, false, 'o drain espera o envio pendente');
    release();
    w.control.mailerGate = undefined;
    await draining;
    assert.equal(w.sent.length, before + 1);
  });
});

describe('reenviar', () => {
  it('dentro de 60 s é 429 com Retry-After; depois gera segredo novo (o link antigo morre) e validade nova', async () => {
    const { owner, company } = await w.setup('Empresa do reenvio');
    const email = w.freshEmail('reenv');
    const first = await w.inviteOk(owner, company, email);
    const url = `/admin/companies/${company}/invitations/${first.item.id}/resend`;
    const tooSoon = await w.request('POST', url, { cookie: owner.cookie });
    assert.equal(tooSoon.statusCode, 429);
    assert.equal(errorOf(tooSoon).code, 'INVITATION_LIMIT_REACHED');
    assert.ok(Number(tooSoon.headers['retry-after']) >= 1);
    assert.ok(Number(tooSoon.headers['retry-after']) <= 60);

    w.control.offsetMs = 61_000;
    try {
      const before = w.sent.length;
      const again = await w.request('POST', url, { cookie: owner.cookie });
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(again.json<{ sendCount: number }>().sendCount, 2);
      await w.invitations.drain();
      const second = tokenOf(w.sent[before]);
      assert.notEqual(second, first.token);
      // O link antigo dá a falha uniforme; o novo vale.
      const old = await preview(first.token ?? '');
      assert.equal(old.statusCode, 400);
      assert.deepEqual(errorOf(old), UNIFORM);
      assert.equal((await preview(second)).statusCode, 200);
    } finally {
      w.control.offsetMs = 0;
    }
  });

  it('o 7º envio é 429 (teto de 6 por convite); convite fechado é 409; ADMIN não reenvia convite de ADMIN', async () => {
    const { owner, company } = await w.setup('Empresa do teto de reenvios');
    const first = await w.inviteOk(owner, company, w.freshEmail('teto'));
    const url = `/admin/companies/${company}/invitations/${first.item.id}/resend`;
    try {
      for (let send = 2; send <= 6; send += 1) {
        w.control.offsetMs = (send - 1) * 61_000;
        const response = await w.request('POST', url, { cookie: owner.cookie });
        assert.equal(response.statusCode, 200, `envio ${String(send)}: ${response.body}`);
      }
      w.control.offsetMs = 6 * 61_000;
      const seventh = await w.request('POST', url, { cookie: owner.cookie });
      assert.equal(seventh.statusCode, 429);
      assert.equal(errorOf(seventh).code, 'INVITATION_LIMIT_REACHED');
    } finally {
      w.control.offsetMs = 0;
    }
    await w.invitations.drain();

    const revoked = await w.inviteOk(owner, company, w.freshEmail('fechado'));
    await w.request('DELETE', `/admin/companies/${company}/invitations/${revoked.item.id}`, {
      cookie: owner.cookie,
    });
    const closed = await w.request(
      'POST',
      `/admin/companies/${company}/invitations/${revoked.item.id}/resend`,
      { cookie: owner.cookie },
    );
    assert.equal(closed.statusCode, 409);
    assert.equal(errorOf(closed).code, 'INVITATION_NOT_PENDING');

    const admin = await member('reenvadm', company, 'ADMIN');
    const adminInvite = await w.inviteOk(owner, company, w.freshEmail('paraadm'), 'ADMIN');
    const denied = await w.request(
      'POST',
      `/admin/companies/${company}/invitations/${adminInvite.item.id}/resend`,
      { cookie: admin.person.cookie },
    );
    assert.equal(denied.statusCode, 403);
  });
});

describe('revogar', () => {
  it('o link revogado dá a falha uniforme; revogar de novo é 204; convite aceito é 409; ADMIN não revoga convite de ADMIN', async () => {
    const { owner, company } = await w.setup('Empresa da revogação');
    const created = await w.inviteOk(owner, company, w.freshEmail('rev'));
    const url = `/admin/companies/${company}/invitations/${created.item.id}`;
    assert.equal((await preview(created.token ?? '')).statusCode, 200);
    assert.equal((await w.request('DELETE', url, { cookie: owner.cookie })).statusCode, 204);
    assert.equal((await w.request('DELETE', url, { cookie: owner.cookie })).statusCode, 204);
    const dead = await preview(created.token ?? '');
    assert.equal(dead.statusCode, 400);
    assert.deepEqual(errorOf(dead), UNIFORM);
    const row = await w.db.prisma.companyInvitation.findFirst({
      where: { id: created.item.id, companyId: company },
    });
    assert.equal(row?.status, 'REVOKED');
    assert.equal(row.email, null);
    assert.equal(row.tokenHash, null);

    // Aceito: não se revoga.
    const person = await w.signUp('aceita');
    const accepted = await w.inviteOk(owner, company, person.email);
    const accept = await w.request('POST', '/auth/invitations/accept', {
      cookie: person.cookie,
      payload: { token: accepted.token },
    });
    assert.equal(accept.statusCode, 204);
    const late = await w.request(
      'DELETE',
      `/admin/companies/${company}/invitations/${accepted.item.id}`,
      {
        cookie: owner.cookie,
      },
    );
    assert.equal(late.statusCode, 409);
    assert.equal(errorOf(late).code, 'INVITATION_NOT_PENDING');

    const admin = await member('revadm', company, 'ADMIN');
    const adminInvite = await w.inviteOk(owner, company, w.freshEmail('adm'), 'ADMIN');
    assert.equal(
      (
        await w.request(
          'DELETE',
          `/admin/companies/${company}/invitations/${adminInvite.item.id}`,
          {
            cookie: admin.person.cookie,
          },
        )
      ).statusCode,
      403,
    );
  });

  it(':invitationId malformado, de outra empresa e inexistente dão o MESMO 404 (status, code e message)', async () => {
    const { owner, company } = await w.setup('Empresa do 404 de convite');
    const stranger = await w.signUp('estranho404');
    const strangerCompany = await w.createCompany(stranger, 'Empresa estranha');
    const foreign = await w.inviteOk(stranger, strangerCompany, w.freshEmail('f'));
    const shapes: unknown[] = [];
    for (const id of ['nao-e-uuid', randomUUID(), foreign.item.id]) {
      for (const [method, suffix] of [
        ['DELETE', ''],
        ['POST', '/resend'],
      ] as const) {
        const response = await w.request(
          method,
          `/admin/companies/${company}/invitations/${id}${suffix}`,
          {
            cookie: owner.cookie,
          },
        );
        assert.equal(response.statusCode, 404);
        shapes.push({ status: response.statusCode, ...errorOf(response) });
      }
    }
    assert.equal(new Set(shapes.map((shape) => JSON.stringify(shape))).size, 1);
    // O convite alheio continua intacto.
    const intact = await w.db.prisma.companyInvitation.findFirst({
      where: { id: foreign.item.id, companyId: strangerCompany },
    });
    assert.equal(intact?.status, 'PENDING');
  });
});

describe('isolamento entre empresas', () => {
  it('o convite de A nunca aparece na lista de B; token de A com companyId de B (e o inverso) é a falha uniforme', async () => {
    const { owner, company: companyC } = await w.setup('Empresa C isolada');
    const other = await w.signUp('isolada');
    const companyB = await w.createCompany(other, 'Empresa B isolada');
    const a = await w.inviteOk(owner, companyC, w.freshEmail('iso-a'));
    const b = await w.inviteOk(other, companyB, w.freshEmail('iso-b'));
    const listB = await w.request('GET', `/admin/companies/${companyB}/invitations`, {
      cookie: other.cookie,
    });
    const idsB = listB.json<{ items: { id: string }[] }>().items.map((item) => item.id);
    assert.deepEqual(idsB, [b.item.id]);
    // companyId trocado no token: a linha não existe naquela empresa.
    const forgedA = (a.token ?? '').replace(companyC, companyB);
    const forgedB = (b.token ?? '').replace(companyB, companyC);
    for (const token of [forgedA, forgedB]) {
      const response = await preview(token);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(errorOf(response), UNIFORM);
    }
    // Aceitar o convite de C com a conta certa nunca cria vínculo em B.
    const invitee = await w.signUp('iso-conta');
    const forC = await w.inviteOk(owner, companyC, invitee.email);
    const before = await w.db.prisma.membership.count({ where: { companyId: companyB } });
    assert.equal(
      (
        await w.request('POST', '/auth/invitations/accept', {
          cookie: invitee.cookie,
          payload: { token: forC.token },
        })
      ).statusCode,
      204,
    );
    assert.equal(await w.db.prisma.membership.count({ where: { companyId: companyB } }), before);
    assert.equal(
      await w.db.prisma.membership.count({
        where: { companyId: companyC, accountId: invitee.accountId },
      }),
      1,
    );
  });
});

describe('modo de contas e sem contas', () => {
  it('POST /memberships e /password seguem 403 no modo de contas (regressão)', async () => {
    const { owner, company } = await w.setup('Empresa da regressão');
    const create = await w.request('POST', `/admin/companies/${company}/memberships`, {
      cookie: owner.cookie,
      payload: { email: w.freshEmail('m'), password: 'uma-senha-bem-longa-123', role: 'AGENT' },
    });
    assert.equal(create.statusCode, 403);
    const reset = await w.request(
      'POST',
      `/admin/companies/${company}/memberships/${randomUUID()}/password`,
      { cookie: owner.cookie, payload: { newPassword: 'uma-senha-bem-longa-123' } },
    );
    assert.equal(reset.statusCode, 403);
  });

  it('com ACCOUNTS_ENABLED=false as rotas de convite não existem (404)', async () => {
    const { buildServer } = await import('./server.js');
    const bare = buildServer({
      logger: w.logs.logger,
      readiness: { database: () => w.db.check(), redis: () => w.db.check() },
    });
    for (const [method, url] of [
      ['POST', '/auth/invitations/preview'],
      ['POST', '/auth/invitations/accept'],
      ['POST', '/auth/invitations/accept-new'],
      ['GET', `/admin/companies/${randomUUID()}/invitations`],
      ['POST', `/admin/companies/${randomUUID()}/invitations`],
    ] as const) {
      const response = await bare.inject({
        method,
        url,
        payload: method === 'POST' ? {} : undefined,
      });
      assert.equal(response.statusCode, 404, url);
    }
    await bare.close();
  });
});

describe('gestão de membros com o cookie (ponte): vale na requisição seguinte, sem revogar a conta', () => {
  it('desativar o vínculo corta o acesso (401) só naquela empresa; mudar o papel muda as permissões; reativar devolve o acesso', async () => {
    const { owner, company } = await w.setup('Empresa da gestão');
    const target = await w.signUp('alvo');
    const membershipId = await w.join(target, company, 'ADMIN');
    // A pessoa também tem acesso a outra empresa, que não pode ser afetada.
    const own = await w.createCompany(target, 'Empresa própria da pessoa');
    await w.request('POST', `/account/companies/${company}/select`, {
      cookie: target.cookie,
      payload: {},
    });
    const get = (cookie: string) =>
      w.request('GET', `/admin/companies/${company}/invitations`, { cookie });
    assert.equal((await get(target.cookie)).statusCode, 200);

    const patch = (payload: object) =>
      w.request('PATCH', `/admin/companies/${company}/memberships/${membershipId}`, {
        cookie: owner.cookie,
        payload,
      });
    assert.equal((await patch({ role: 'VIEWER' })).statusCode, 200);
    assert.equal((await get(target.cookie)).statusCode, 403);
    const permissions = await w.request('GET', '/account/companies', { cookie: target.cookie });
    const item = permissions
      .json<{ items: { companyId: string; role: string; permissions: string[] }[] }>()
      .items.find((entry) => entry.companyId === company);
    assert.equal(item?.role, 'VIEWER');
    assert.ok(!item.permissions.includes('membership:read'));

    assert.equal((await patch({ status: 'DISABLED' })).statusCode, 200);
    assert.equal((await get(target.cookie)).statusCode, 401);
    // A conta continua entrando nas outras empresas (nenhuma revogação em massa).
    const stillThere = await w.request('GET', '/account/companies', { cookie: target.cookie });
    assert.equal(stillThere.statusCode, 200);
    assert.ok(
      stillThere.json<{ items: { companyId: string }[] }>().items.some((e) => e.companyId === own),
    );

    assert.equal((await patch({ status: 'ACTIVE', role: 'ADMIN' })).statusCode, 200);
    assert.equal((await get(target.cookie)).statusCode, 200);
  });

  it('convite pendente nunca conta como OWNER ativo', async () => {
    const { owner, company } = await w.setup('Empresa dos donos');
    await w.inviteOk(owner, company, w.freshEmail('pendente'), 'ADMIN');
    const owners = await w.db.prisma.membership.count({
      where: { companyId: company, role: 'OWNER', status: 'ACTIVE' },
    });
    assert.equal(owners, 1);
  });

  it('empresa suspensa corta o acesso (401) e não grava nem envia convite; ao voltar, o acesso volta', async () => {
    const { owner, company } = await w.setup('Empresa que será suspensa');
    await w.db.prisma.company.update({ where: { id: company }, data: { status: 'SUSPENDED' } });
    try {
      const before = w.sent.length;
      const response = await w.invite(owner, company, w.freshEmail('susp'));
      assert.equal(response.statusCode, 401);
      await w.invitations.drain();
      assert.equal(w.sent.length, before);
      assert.equal(await w.db.prisma.companyInvitation.count({ where: { companyId: company } }), 0);
      // Mesmo por um caminho sem a ponte do cookie, o service recusa criar em empresa suspensa (403).
      const membership = await w.db.prisma.membership.findFirst({
        where: { companyId: company, accountId: owner.accountId },
      });
      assert.ok(membership);
      const identity = {
        kind: 'membership' as const,
        companyId: CompanyId.parse(company),
        membershipId: MembershipId.parse(membership.id),
        role: 'OWNER' as const,
        sessionId: randomUUID(),
      };
      await assert.rejects(
        w.invitations.create(identity, { email: w.freshEmail('susp2'), role: 'AGENT' }),
        ForbiddenError,
      );
    } finally {
      await w.db.prisma.company.update({ where: { id: company }, data: { status: 'ACTIVE' } });
    }
    assert.equal((await w.invite(owner, company, w.freshEmail('volta'))).statusCode, 201);
    await w.invitations.drain();
  });
});
