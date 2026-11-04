import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  INVITATION_INVALID_MESSAGE,
  type InvitationService,
} from '../../application/invitations/invitation.service.js';
import type { InvitationUnitOfWork } from '../../application/ports/invitation-unit-of-work.js';
import { logContains } from '../../test-support/log-capture.js';
import {
  createInvitationWorld,
  errorOf,
  type InvitationWorld,
  PASSWORD,
  type Person,
  tokenOf,
} from '../../test-support/invitation-world.js';

// Spec 025: as três jornadas de aceite (conta logada, deslogada e sem conta), a falha uniforme, a
// concorrência e a privacidade. Servidor real, Postgres e Redis reais; e-mail falso.
let w: InvitationWorld;

before(async () => {
  w = await createInvitationWorld('inv-accept');
});

after(async () => {
  await w.close();
});

const UNIFORM = { code: 'INVITATION_INVALID', message: INVITATION_INVALID_MESSAGE };
const NEW_PASSWORD = 'NovaSenha1';

const preview = (token: string) =>
  w.request('POST', '/auth/invitations/preview', { payload: { token } });
const accept = (token: string, cookie?: string) =>
  w.request('POST', '/auth/invitations/accept', {
    payload: { token },
    ...(cookie === undefined ? {} : { cookie }),
  });
const acceptNew = (token: string, password: string) =>
  w.request('POST', '/auth/invitations/accept-new', { payload: { token, password } });

const membershipsOf = (companyId: string, email: string) =>
  w.db.prisma.membership.findMany({ where: { companyId, email } });
const invitationRow = (companyId: string, id: string) =>
  w.db.prisma.companyInvitation.findFirst({ where: { id, companyId } });

/** Convida por e-mail de uma conta que já existe e devolve o token enviado. */
async function inviteExisting(owner: Person, company: string, person: Person, role = 'VIEWER') {
  const result = await w.inviteOk(owner, company, person.email, role);
  assert.ok(result.token);
  return { ...result, token: result.token };
}

/** Convite para um e-mail sem conta. */
async function inviteNew(owner: Person, company: string, role = 'AGENT') {
  const email = w.freshEmail('novo');
  const result = await w.inviteOk(owner, company, email, role);
  assert.ok(result.token);
  return { ...result, token: result.token, email };
}

describe('preview: mostra o convite sem consumir nada', () => {
  it('devolve empresa, papel, e-mail e accountState (EXISTS só para conta confirmada) com no-store', async () => {
    const { owner, company } = await w.setup('Empresa do preview');
    const confirmed = await w.signUp('confirmada');
    const existing = await inviteExisting(owner, company, confirmed, 'ADMIN');
    const response = await preview(existing.token);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const { name } = (await w.db.prisma.company.findFirst({ where: { id: company } })) ?? {};
    assert.deepEqual(response.json(), {
      companyName: name,
      role: 'ADMIN',
      email: confirmed.email,
      accountState: 'EXISTS',
    });

    const fresh = await inviteNew(owner, company);
    assert.equal((await preview(fresh.token)).json<{ accountState: string }>().accountState, 'NEW');
    // Conta NÃO confirmada conta como NEW (é o que leva ao accept-new).
    const unconfirmedEmail = w.freshEmail('naoconf');
    await w.request('POST', '/auth/register', {
      payload: { email: unconfirmedEmail, password: PASSWORD },
    });
    const pending = await w.inviteOk(owner, company, unconfirmedEmail);
    assert.equal(
      (await preview(pending.token ?? '')).json<{ accountState: string }>().accountState,
      'NEW',
    );
  });

  it('não consome nem altera o convite: várias chamadas e o aceite depois funciona', async () => {
    const { owner, company } = await w.setup('Empresa do preview repetido');
    const person = await w.signUp('repetida');
    const invitation = await inviteExisting(owner, company, person);
    const before = await invitationRow(company, invitation.item.id);
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await preview(invitation.token)).statusCode, 200);
    }
    assert.deepEqual(await invitationRow(company, invitation.item.id), before);
    assert.equal((await accept(invitation.token, person.cookie)).statusCode, 204);
  });
});

describe('caso (a): conta confirmada, logada, mesmo e-mail', () => {
  it('cria o vínculo com o papel do convite, fecha o convite, audita, seleciona a empresa e libera as rotas do papel', async () => {
    const { owner, company } = await w.setup('Empresa do aceite');
    const person = await w.signUp('aceita');
    const invitation = await inviteExisting(owner, company, person, 'VIEWER');
    const response = await accept(invitation.token, person.cookie);
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['set-cookie'], undefined);

    const [membership] = await membershipsOf(company, person.email);
    assert.equal(membership?.role, 'VIEWER');
    assert.equal(membership.status, 'ACTIVE');
    assert.equal(membership.accountId, person.accountId);
    assert.equal(membership.passwordHash, 'account-managed');

    const closed = await invitationRow(company, invitation.item.id);
    assert.equal(closed?.status, 'ACCEPTED');
    assert.equal(closed.email, null);
    assert.equal(closed.tokenHash, null);
    assert.equal(closed.acceptedMembershipId, membership.id);

    const events = await w.db.prisma.auditEvent.findMany({
      where: { companyId: company, action: 'INVITATION_ACCEPTED' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorMembershipId, membership.id);
    assert.equal(events[0].targetMembershipId, membership.id);
    assert.equal(events[0].invitationId, invitation.item.id);
    assert.equal(events[0].toRole, 'VIEWER');

    // A empresa nova é a selecionada e o papel decide o que a pessoa alcança.
    const session = await w.request('GET', '/auth/session', { cookie: person.cookie });
    assert.equal(session.json<{ selectedCompanyId: string }>().selectedCompanyId, company);
    const conversations = await w.request('GET', `/admin/companies/${company}/conversations`, {
      cookie: person.cookie,
    });
    assert.equal(conversations.statusCode, 200);
    const denied = await w.request('GET', `/admin/companies/${company}/invitations`, {
      cookie: person.cookie,
    });
    assert.equal(denied.statusCode, 403);
    // O link usado não vale mais.
    const reused = await accept(invitation.token, person.cookie);
    assert.equal(reused.statusCode, 400);
    assert.deepEqual(errorOf(reused), UNIFORM);
  });

  it('falha na auditoria desfaz o vínculo e o fechamento do convite (mesma transação)', async () => {
    const { owner, company } = await w.setup('Empresa do rollback');
    const person = await w.signUp('rollback');
    const invitation = await inviteExisting(owner, company, person);
    const failing: InvitationUnitOfWork = {
      run: (fn) =>
        w.unitOfWork.run((tx) => {
          const audit = Object.create(tx.audit) as typeof tx.audit;
          audit.create = () => Promise.reject(new Error('falha forçada na auditoria'));
          return fn({ ...tx, audit });
        }),
    };
    const service: InvitationService = w.buildInvitations({ unitOfWork: failing });
    await assert.rejects(
      service.accept({ id: person.accountId, email: person.email }, invitation.token),
    );
    assert.equal((await membershipsOf(company, person.email)).length, 0);
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'PENDING');
    // E o convite segue válido para o aceite de verdade.
    assert.equal((await accept(invitation.token, person.cookie)).statusCode, 204);
  });
});

describe('caso (b): sem sessão ou com outro e-mail', () => {
  it('sem cookie é 401; depois do login o mesmo accept funciona', async () => {
    const { owner, company } = await w.setup('Empresa do aceite deslogado');
    const person = await w.signUp('deslogada');
    const invitation = await inviteExisting(owner, company, person);
    const anonymous = await accept(invitation.token);
    assert.equal(anonymous.statusCode, 401);
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'PENDING');
    const again = await w.login(person.email);
    assert.equal((await accept(invitation.token, again.cookie)).statusCode, 204);
  });

  it('conta com e-mail DIFERENTE recebe a falha uniforme idêntica à de token inexistente, sem vínculo e sem consumir o convite', async () => {
    const { owner, company } = await w.setup('Empresa do e-mail diferente');
    const invited = await w.signUp('convidada');
    const other = await w.signUp('outra-conta');
    const invitation = await inviteExisting(owner, company, invited);
    const wrong = await accept(invitation.token, other.cookie);
    const missing = await accept(
      `${company}.${randomUUID()}.${invitation.token.split('.')[2]}`,
      other.cookie,
    );
    assert.equal(wrong.statusCode, 400);
    assert.deepEqual(
      { status: wrong.statusCode, ...errorOf(wrong) },
      { status: missing.statusCode, ...errorOf(missing) },
    );
    assert.deepEqual(errorOf(wrong), UNIFORM);
    assert.equal((await membershipsOf(company, other.email)).length, 0);
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'PENDING');
    assert.equal((await accept(invitation.token, invited.cookie)).statusCode, 204);
  });
});

describe('caso (c): sem conta ou com conta não confirmada', () => {
  it('cria conta já confirmada (sem o código da 020), vínculo e convite fechado, sem cookie; senha fraca é 400 sem consultar nada; o hash só vem depois da pré-checagem', async () => {
    const { owner, company } = await w.setup('Empresa do aceite sem conta');
    const invitation = await inviteNew(owner, company, 'AGENT');
    const hashes = w.passwords.hashCalls;
    // Política do cadastro: 400 antes de qualquer consulta, e o convite fica intacto.
    for (const weak of ['abc', 'semmaiuscula1', 'SemNumero', '']) {
      const response = await acceptNew(invitation.token, weak);
      assert.equal(response.statusCode, 400);
      assert.equal(errorOf(response).code, 'VALIDATION_ERROR');
      assert.ok(!response.body.includes(weak) || weak === '');
    }
    // Token inválido: a falha uniforme, sem pagar scrypt.
    const bogus = await acceptNew(`${invitation.token}x`, NEW_PASSWORD);
    assert.deepEqual(errorOf(bogus), UNIFORM);
    assert.equal(w.passwords.hashCalls, hashes);
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'PENDING');

    const response = await acceptNew(invitation.token, NEW_PASSWORD);
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(w.passwords.hashCalls, hashes + 1);

    const account = await w.accountRepository.findByEmail(invitation.email);
    assert.ok(account?.emailVerifiedAt);
    const [membership] = await membershipsOf(company, invitation.email);
    assert.equal(membership?.role, 'AGENT');
    assert.equal(membership.accountId, account.id);
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'ACCEPTED');
    // A pessoa entra com a senha que definiu (sem código de confirmação).
    assert.equal(
      (
        await w.request('POST', '/auth/login', {
          payload: { email: invitation.email, password: NEW_PASSWORD },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await w.request('POST', '/auth/login', {
          payload: { email: invitation.email, password: 'Errada9' },
        })
      ).statusCode,
      401,
    );
  });

  it('conta NÃO confirmada existente: a senha é SUBSTITUÍDA, a conta é confirmada e os códigos pendentes morrem', async () => {
    const { owner, company } = await w.setup('Empresa do pré-cadastro hostil');
    const email = w.freshEmail('preca');
    const hostile = 'Hostil1pass';
    assert.equal(
      (await w.request('POST', '/auth/register', { payload: { email, password: hostile } }))
        .statusCode,
      202,
    );
    await w.accounts.drain();
    // Um código de recuperação pendente nem chega a existir (conta não confirmada), mas o de
    // confirmação sim: força também os campos de recuperação para provar que são limpos.
    const code = (await w.db.prisma.account.findUnique({ where: { email } }))?.verificationHash;
    assert.ok(code);
    await w.db.prisma.account.update({
      where: { email },
      data: { resetHash: 'reset-pendente', resetExpiresAt: new Date(Date.now() + 60_000) },
    });
    const invitation = await w.inviteOk(owner, company, email);
    assert.equal((await acceptNew(invitation.token ?? '', NEW_PASSWORD)).statusCode, 204);
    const row = await w.db.prisma.account.findUnique({ where: { email } });
    assert.ok(row?.emailVerifiedAt);
    assert.equal(row.verificationHash, null);
    assert.equal(row.verificationExpiresAt, null);
    assert.equal(row.resetHash, null);
    assert.equal(row.resetExpiresAt, null);
    // A senha do pré-cadastro não loga mais; a nova sim.
    const old = await w.request('POST', '/auth/login', { payload: { email, password: hostile } });
    assert.equal(old.statusCode, 401);
    const fresh = await w.request('POST', '/auth/login', {
      payload: { email, password: NEW_PASSWORD },
    });
    assert.equal(fresh.statusCode, 204);
  });

  it('conta confirmada ou desativada nesse caminho é a falha uniforme, sem alterar nada', async () => {
    const { owner, company } = await w.setup('Empresa da conta confirmada');
    const confirmed = await w.signUp('jaconfirmada');
    const invitation = await inviteExisting(owner, company, confirmed);
    const hashes = w.passwords.hashCalls;
    const response = await acceptNew(invitation.token, NEW_PASSWORD);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(errorOf(response), UNIFORM);
    // Nem pagou hash, nem trocou a senha, nem criou vínculo.
    assert.equal(w.passwords.hashCalls, hashes);
    assert.equal((await membershipsOf(company, confirmed.email)).length, 0);
    assert.equal(
      (
        await w.request('POST', '/auth/login', {
          payload: { email: confirmed.email, password: PASSWORD },
        })
      ).statusCode,
      204,
    );

    const disabled = await w.signUp('desativada');
    const forDisabled = await inviteExisting(owner, company, disabled);
    await w.db.prisma.account.update({
      where: { email: disabled.email },
      data: { status: 'DISABLED' },
    });
    for (const attempt of [
      preview(forDisabled.token),
      acceptNew(forDisabled.token, NEW_PASSWORD),
    ]) {
      const result = await attempt;
      assert.equal(result.statusCode, 400);
      assert.deepEqual(errorOf(result), UNIFORM);
    }
    assert.equal((await membershipsOf(company, disabled.email)).length, 0);
  });
});

describe('concorrência e atomicidade', () => {
  it('aceitar o mesmo convite várias vezes ao mesmo tempo cria UM vínculo e as demais recebem a falha uniforme (caso a)', async () => {
    const { owner, company } = await w.setup('Empresa da corrida (a)');
    for (let round = 0; round < 3; round += 1) {
      const person = await w.signUp(`corrida-a${String(round)}`);
      const invitation = await inviteExisting(owner, company, person);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => accept(invitation.token, person.cookie)),
      );
      assert.equal(
        results.filter((r) => r.statusCode === 204).length,
        1,
        `rodada ${String(round)}`,
      );
      for (const loser of results.filter((r) => r.statusCode !== 204)) {
        assert.equal(loser.statusCode, 400);
        assert.deepEqual(errorOf(loser), UNIFORM);
      }
      assert.equal((await membershipsOf(company, person.email)).length, 1);
    }
  });

  it('dois accept-new simultâneos do mesmo convite: um vence, uma conta, um vínculo (caso c)', async () => {
    const { owner, company } = await w.setup('Empresa da corrida (c)');
    for (let round = 0; round < 3; round += 1) {
      const invitation = await inviteNew(owner, company);
      const results = await Promise.all([
        acceptNew(invitation.token, NEW_PASSWORD),
        acceptNew(invitation.token, NEW_PASSWORD),
        acceptNew(invitation.token, 'Outra2senha'),
      ]);
      assert.equal(
        results.filter((r) => r.statusCode === 204).length,
        1,
        `rodada ${String(round)}`,
      );
      assert.equal(await w.db.prisma.account.count({ where: { email: invitation.email } }), 1);
      assert.equal((await membershipsOf(company, invitation.email)).length, 1);
    }
  });

  it('aceitar enquanto o proprietário revoga: ou vínculo e ACCEPTED, ou nenhum vínculo e REVOKED, nunca os dois', async () => {
    const { owner, company } = await w.setup('Empresa da revogação concorrente');
    let accepted = 0;
    let revoked = 0;
    for (let round = 0; round < 12; round += 1) {
      const person = await w.signUp(`rev${String(round)}`);
      const invitation = await inviteExisting(owner, company, person);
      const [acceptResult, revokeResult] = await Promise.all([
        accept(invitation.token, person.cookie),
        w.request('DELETE', `/admin/companies/${company}/invitations/${invitation.item.id}`, {
          cookie: owner.cookie,
        }),
      ]);
      const members = await membershipsOf(company, person.email);
      const row = await invitationRow(company, invitation.item.id);
      if (acceptResult.statusCode === 204) {
        accepted += 1;
        assert.equal(revokeResult.statusCode, 409, `rodada ${String(round)}`);
        assert.equal(members.length, 1);
        assert.equal(row?.status, 'ACCEPTED');
      } else {
        revoked += 1;
        assert.equal(acceptResult.statusCode, 400);
        assert.deepEqual(errorOf(acceptResult), UNIFORM);
        assert.equal(revokeResult.statusCode, 204);
        assert.equal(members.length, 0);
        assert.equal(row?.status, 'REVOKED');
      }
    }
    assert.equal(accepted + revoked, 12);
  });

  it('convidador desativado ou rebaixado depois de convidar: o aceite é a falha uniforme, o convite é fechado e não há vínculo', async () => {
    const { company } = await w.setup('Empresa do convidador caído');
    for (const change of [{ status: 'DISABLED' as const }, { role: 'AGENT' as const }]) {
      const inviter = await w.signUp('convidador');
      const inviterId = await w.join(inviter, company, 'ADMIN');
      const person = await w.signUp('convidada-do-adm');
      const invitation = await inviteExisting(inviter, company, person, 'AGENT');
      await w.db.prisma.membership.updateMany({
        where: { id: inviterId, companyId: company },
        data: change,
      });
      const response = await accept(invitation.token, person.cookie);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(errorOf(response), UNIFORM);
      assert.equal((await membershipsOf(company, person.email)).length, 0);
      const row = await invitationRow(company, invitation.item.id);
      assert.equal(row?.status, 'REVOKED');
      assert.equal(row.email, null);
    }
  });

  it('aceitar enquanto o convidador é desativado: nunca há vínculo com convidador sem hierarquia depois do bloqueio', async () => {
    const { owner, company } = await w.setup('Empresa da desativação concorrente');
    for (let round = 0; round < 8; round += 1) {
      const inviter = await w.signUp('convidador-c');
      const inviterId = await w.join(inviter, company, 'ADMIN');
      const person = await w.signUp(`conc${String(round)}`);
      const invitation = await inviteExisting(inviter, company, person, 'AGENT');
      const [acceptResult] = await Promise.all([
        accept(invitation.token, person.cookie),
        w.request('PATCH', `/admin/companies/${company}/memberships/${inviterId}`, {
          cookie: owner.cookie,
          payload: { status: 'DISABLED' },
        }),
      ]);
      const members = await membershipsOf(company, person.email);
      const row = await invitationRow(company, invitation.item.id);
      if (acceptResult.statusCode === 204) {
        // O aceite venceu a corrida: o convidador ainda valia na hora do bloqueio.
        assert.equal(members.length, 1);
        assert.equal(row?.status, 'ACCEPTED');
      } else {
        assert.equal(members.length, 0);
        assert.notEqual(row?.status, 'ACCEPTED');
      }
    }
  });

  it('empresa suspensa entre o envio e o aceite: falha uniforme e nenhum vínculo', async () => {
    const { owner, company } = await w.setup('Empresa suspensa');
    const person = await w.signUp('suspensa');
    const invitation = await inviteExisting(owner, company, person);
    await w.db.prisma.company.update({ where: { id: company }, data: { status: 'SUSPENDED' } });
    try {
      const response = await accept(invitation.token, person.cookie);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(errorOf(response), UNIFORM);
      assert.deepEqual(errorOf(await preview(invitation.token)), UNIFORM);
      assert.equal((await membershipsOf(company, person.email)).length, 0);
    } finally {
      await w.db.prisma.company.update({ where: { id: company }, data: { status: 'ACTIVE' } });
    }
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'PENDING');
  });

  it('conta que já tem vínculo na empresa: falha uniforme e convite fechado (convite não rebaixa nem reativa)', async () => {
    const { owner, company } = await w.setup('Empresa do vínculo existente');
    const person = await w.signUp('jamembro');
    const invitation = await inviteExisting(owner, company, person, 'AGENT');
    // A pessoa vira membro por outro caminho antes de aceitar.
    await w.join(person, company, 'VIEWER');
    const response = await accept(invitation.token, person.cookie);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(errorOf(response), UNIFORM);
    const members = await membershipsOf(company, person.email);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.role, 'VIEWER');
    assert.equal((await invitationRow(company, invitation.item.id))?.status, 'REVOKED');
  });
});

describe('falha uniforme', () => {
  it('malformado, segredo trocado, outro invitationId, expirado, usado, revogado: a mesma 400; a métrica distingue só pelo rótulo', async () => {
    const { owner, company } = await w.setup('Empresa da falha uniforme');
    const person = await w.signUp('uniforme');
    const good = await inviteExisting(owner, company, person);
    const second = await inviteNew(owner, company);
    const [companyId, invitationId, secret] = good.token.split('.') as [string, string, string];
    const flipped = `${secret.slice(0, 42)}${secret.endsWith('A') ? 'B' : 'A'}`;
    const tokens = [
      'lixo',
      '',
      `${companyId}.${invitationId}.${flipped}`,
      `${companyId}.${second.item.id}.${secret}`,
      `${randomUUID()}.${invitationId}.${secret}`,
      `${companyId}.${randomUUID()}.${secret}`,
      `${good.token}.extra`,
      'a'.repeat(5000),
    ];
    for (const token of tokens) {
      for (const response of [
        await preview(token),
        await accept(token, person.cookie),
        await acceptNew(token, NEW_PASSWORD),
      ]) {
        assert.equal(response.statusCode, 400, token.slice(0, 30));
        assert.deepEqual(errorOf(response), UNIFORM);
      }
    }
    // Expirado (relógio deslocado), usado e revogado.
    w.control.offsetMs = 8 * 24 * 60 * 60_000;
    try {
      assert.deepEqual(errorOf(await preview(second.token)), UNIFORM);
    } finally {
      w.control.offsetMs = 0;
    }
    assert.equal((await accept(good.token, person.cookie)).statusCode, 204);
    assert.deepEqual(errorOf(await preview(good.token)), UNIFORM);
    const third = await inviteNew(owner, company);
    await w.request('DELETE', `/admin/companies/${company}/invitations/${third.item.id}`, {
      cookie: owner.cookie,
    });
    assert.deepEqual(errorOf(await preview(third.token)), UNIFORM);

    const metrics = await w.metrics.render();
    for (const action of ['preview', 'accept', 'accept_new']) {
      assert.match(
        metrics,
        new RegExp(`company_invitations_total\\{action="${action}",result="invalid"\\} \\d+`),
      );
    }
    assert.match(metrics, /company_invitations_total\{action="accept",result="ok"\} \d+/);
  });

  it('rota de preview sem Origin e X-Soprei-App é 403 e campo extra no corpo é 400', async () => {
    const noHeaders = await w.app.inject({
      method: 'POST',
      url: '/auth/invitations/preview',
      payload: { token: 'x' },
    });
    assert.equal(noHeaders.statusCode, 403);
    const extra = await w.request('POST', '/auth/invitations/preview', {
      payload: { token: 'x', extra: 1 },
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(errorOf(extra).code, 'VALIDATION_ERROR');
  });
});

describe('privacidade: log, métrica, auditoria e erros', () => {
  it('nada de e-mail do convidado, segredo, link, token ou nome da empresa em log ou métrica; auditoria sem e-mail', async () => {
    const secretName = `NomeSecreto${randomUUID().slice(0, 8)}`;
    const { owner, company } = await w.setup(secretName);
    const person = await w.signUp('privada');
    const existing = await inviteExisting(owner, company, person);
    const fresh = await inviteNew(owner, company);
    await accept(existing.token, person.cookie);
    await acceptNew(fresh.token, NEW_PASSWORD);
    await preview(`${company}.${randomUUID()}.${'A'.repeat(43)}`);
    const resent = await inviteNew(owner, company);
    w.control.offsetMs = 61_000;
    try {
      await w.request('POST', `/admin/companies/${company}/invitations/${resent.item.id}/resend`, {
        cookie: owner.cookie,
      });
    } finally {
      w.control.offsetMs = 0;
    }
    await w.invitations.drain();

    const raw = w.logs.raw();
    const secrets = [
      person.email,
      fresh.email,
      resent.email,
      secretName,
      ...w.sent.flatMap((entry) => [
        entry.mail.link,
        tokenOf(entry),
        tokenOf(entry).split('.')[2] ?? '',
      ]),
    ];
    for (const secret of secrets)
      assert.equal(logContains(raw, secret), false, secret.slice(0, 20));

    // Métricas: só os dois conjuntos fixos de rótulos, sem e-mail, id nem token.
    const response = await w.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${'m'.repeat(32)}` },
    });
    assert.equal(response.statusCode, 200);
    const lines = response.body
      .split('\n')
      .filter((line) => /^company_invitation(s|_emails)_total\{/.test(line));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const labels: Record<string, string | undefined> = {};
      for (const match of (/\{(.*)\}/.exec(line)?.[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
        labels[match[1] ?? ''] = match[2];
      }
      assert.ok(
        Object.keys(labels).every((key) => ['action', 'result'].includes(key)),
        line,
      );
      if ('action' in labels) {
        assert.ok(
          ['create', 'resend', 'revoke', 'preview', 'accept', 'accept_new', 'purge'].includes(
            labels.action ?? '',
          ),
        );
        assert.ok(
          ['ok', 'invalid', 'forbidden', 'limited', 'conflict', 'mismatch', 'error'].includes(
            labels.result ?? '',
          ),
        );
      } else {
        assert.ok(['sent', 'failed', 'skipped'].includes(labels.result ?? ''));
      }
    }
    for (const secret of secrets) assert.ok(!response.body.includes(secret), secret.slice(0, 20));

    // A trilha aponta para o convite por id e nunca guarda e-mail.
    const audit = await w.request('GET', `/admin/companies/${company}/audit-events?limit=100`, {
      cookie: owner.cookie,
    });
    assert.equal(audit.statusCode, 200);
    const events = audit.json<{ items: { action: string; invitationId: string | null }[] }>().items;
    assert.ok(events.some((e) => e.action === 'INVITATION_CREATED' && e.invitationId !== null));
    assert.ok(events.some((e) => e.action === 'INVITATION_ACCEPTED' && e.invitationId !== null));
    assert.ok(events.some((e) => e.action === 'INVITATION_RESENT'));
    assert.ok(!audit.body.includes('@'));
  });

  it('o corpo dos erros (400, 403, 404, 409, 429) não ecoa o e-mail nem o token enviados', async () => {
    const { owner, company } = await w.setup('Empresa dos erros');
    const email = w.freshEmail('eco');
    const created = await w.inviteOk(owner, company, email);
    const token = created.token ?? '';
    const responses = [
      await w.invite(owner, company, email), // 409
      await w.request('POST', `/admin/companies/${company}/invitations`, {
        cookie: owner.cookie,
        payload: { email, role: 'OWNER' },
      }), // 400
      await w.request('DELETE', `/admin/companies/${company}/invitations/${randomUUID()}`, {
        cookie: owner.cookie,
      }), // 404
      await preview(token.replace(/.$/, 'x')), // 400 uniforme
      await w.request('POST', `/admin/companies/${company}/invitations/${created.item.id}/resend`, {
        cookie: owner.cookie,
      }), // 429
    ];
    const statuses = responses.map((r) => r.statusCode);
    assert.deepEqual(statuses, [409, 400, 404, 400, 429]);
    for (const response of responses) {
      assert.ok(!response.body.includes(email));
      assert.ok(!response.body.includes(token));
      assert.ok(!response.body.includes(token.split('.')[2] ?? '#'));
    }
    const viewer = await w.signUp('viewer-erro');
    await w.join(viewer, company, 'VIEWER');
    const forbidden = await w.invite(viewer, company, email);
    assert.equal(forbidden.statusCode, 403);
    assert.ok(!forbidden.body.includes(email));
  });
});
