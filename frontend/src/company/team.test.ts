import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ApiError } from '../api';
import { pageForPath, pathForPage } from '../account-flow';
import {
  FORBIDDEN_MESSAGE,
  GENERIC_MESSAGE,
  RATE_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from './company-api';
import { allowedPages, AREA_PAGES, areaPageForPath, canOpen } from './company-nav';
import {
  ALREADY_PENDING_MESSAGE,
  INVALID_INPUT_MESSAGE,
  invitationSchema,
  LAST_OWNER_MESSAGE,
  LIMIT_MESSAGE,
  MEMBER_EXISTS_MESSAGE,
  memberSchema,
  NOT_PENDING_MESSAGE,
  teamFailureOf,
} from './team-api';
import {
  assignableRoles,
  canManageRole,
  invitableRoles,
  memberActions,
  resendWaitSeconds,
  roleChangeNeedsConfirmation,
} from './team-rules';

const SENTINEL = 'TEXTO-DO-SERVIDOR-QUE-NAO-PODE-APARECER';

test('a aba Equipe fica depois de Persona e Conhecimento e antes de Testar (e Primeiros passos, que é o último) e só abre com membership:read', () => {
  assert.deepEqual(
    [...AREA_PAGES],
    [
      'conversas',
      'agenda',
      'canal',
      'persona',
      'conhecimento',
      'estoque',
      'equipe',
      'testar',
      // Spec 031 (E4): só para a conta titular, antes de Primeiros passos.
      'assinatura',
      'primeirosPassos',
    ],
  );
  assert.equal(areaPageForPath('/painel/equipe'), 'equipe');
  assert.equal(pageForPath('/painel/equipe'), 'equipe');
  assert.equal(pathForPage('equipe'), '/painel/equipe');
  assert.equal(canOpen('equipe', ['membership:read']), true);
  assert.equal(canOpen('equipe', ['membership:manage']), false);
  // OWNER e ADMIN veem Equipe; AGENT e VIEWER não.
  const owner = [
    'conversation:read',
    'conversation:simulate',
    'membership:read',
    'membership:manage',
  ];
  assert.ok(allowedPages([...owner, 'channel:read', 'persona:manage']).includes('equipe'));
  assert.ok(!allowedPages(['conversation:read', 'conversation:simulate']).includes('equipe'));
  assert.ok(!allowedPages(['conversation:read']).includes('equipe'));
});

test('espelho de canManageRole: os mesmos vetores do backend (spec 008)', () => {
  const table: readonly (readonly [string, string, boolean])[] = [
    ['OWNER', 'OWNER', true],
    ['OWNER', 'ADMIN', true],
    ['OWNER', 'AGENT', true],
    ['OWNER', 'VIEWER', true],
    ['ADMIN', 'OWNER', false],
    ['ADMIN', 'ADMIN', false],
    ['ADMIN', 'AGENT', true],
    ['ADMIN', 'VIEWER', true],
    ['AGENT', 'OWNER', false],
    ['AGENT', 'ADMIN', false],
    ['AGENT', 'AGENT', false],
    ['AGENT', 'VIEWER', false],
    ['VIEWER', 'OWNER', false],
    ['VIEWER', 'AGENT', false],
    ['VIEWER', 'VIEWER', false],
  ];
  for (const [actor, target, expected] of table) {
    assert.equal(canManageRole(actor, target), expected, `${actor} -> ${target}`);
  }
  for (const unknown of ['ROOT', '', 'owner']) {
    assert.equal(canManageRole(unknown, 'AGENT'), false);
    assert.equal(canManageRole('OWNER', unknown), false);
    assert.equal(canManageRole('ADMIN', unknown), false);
  }
});

test('papéis atribuíveis: OWNER convida os três (nunca OWNER) e ADMIN só Atendente e Somente leitura', () => {
  assert.deepEqual(invitableRoles('OWNER'), ['ADMIN', 'AGENT', 'VIEWER']);
  assert.deepEqual(invitableRoles('ADMIN'), ['AGENT', 'VIEWER']);
  assert.deepEqual(invitableRoles('AGENT'), []);
  assert.deepEqual(invitableRoles('VIEWER'), []);
  // Para membros que já existem o OWNER pode promover a OWNER.
  assert.deepEqual(assignableRoles('OWNER'), ['OWNER', 'ADMIN', 'AGENT', 'VIEWER']);
  assert.deepEqual(assignableRoles('ADMIN'), ['AGENT', 'VIEWER']);
  assert.deepEqual(assignableRoles('AGENT'), []);
});

test('ações por linha: nunca na própria linha nem acima da hierarquia', () => {
  const me = randomUUID();
  const other = (role: string) => ({ id: randomUUID(), role });
  assert.equal(memberActions('OWNER', me, { id: me, role: 'OWNER' }).manage, false);
  assert.equal(memberActions('OWNER', me, other('ADMIN')).manage, true);
  assert.equal(memberActions('OWNER', me, other('OWNER')).manage, true);
  assert.equal(memberActions('ADMIN', me, other('OWNER')).manage, false);
  assert.equal(memberActions('ADMIN', me, other('ADMIN')).manage, false);
  assert.equal(memberActions('ADMIN', me, other('AGENT')).manage, true);
  assert.equal(memberActions('AGENT', me, other('VIEWER')).manage, false);
});

test('mudar o papel de OWNER ou ADMIN pede confirmação; de AGENT ou VIEWER não', () => {
  assert.equal(roleChangeNeedsConfirmation('OWNER'), true);
  assert.equal(roleChangeNeedsConfirmation('ADMIN'), true);
  assert.equal(roleChangeNeedsConfirmation('AGENT'), false);
  assert.equal(roleChangeNeedsConfirmation('VIEWER'), false);
});

test('reenvio: a dica de espera é o intervalo de 60 s desde o último envio, nunca negativa', () => {
  const sent = '2026-11-04T12:00:00.000Z';
  const at = Date.parse(sent);
  assert.equal(resendWaitSeconds(sent, at), 60);
  assert.equal(resendWaitSeconds(sent, at + 59_001), 1);
  assert.equal(resendWaitSeconds(sent, at + 60_000), 0);
  assert.equal(resendWaitSeconds(sent, at + 3_600_000), 0);
  assert.equal(resendWaitSeconds('lixo', at), 0);
});

test('mensagens de erro da equipe: escolhidas pelo status e pelo code, nunca pelo texto do servidor', () => {
  const cases: [number, string | undefined, string][] = [
    [409, 'LAST_OWNER', LAST_OWNER_MESSAGE],
    [409, 'MEMBER_ALREADY_EXISTS', MEMBER_EXISTS_MESSAGE],
    [409, 'INVITATION_ALREADY_PENDING', ALREADY_PENDING_MESSAGE],
    [429, 'INVITATION_LIMIT_REACHED', LIMIT_MESSAGE],
    [409, 'INVITATION_NOT_PENDING', NOT_PENDING_MESSAGE],
    [400, 'VALIDATION_ERROR', INVALID_INPUT_MESSAGE],
    [403, 'FORBIDDEN', FORBIDDEN_MESSAGE],
    [429, 'RATE_LIMITED', RATE_MESSAGE],
    [429, undefined, RATE_MESSAGE],
    [502, undefined, UNAVAILABLE_MESSAGE],
    [503, 'SERVICE_UNAVAILABLE', UNAVAILABLE_MESSAGE],
    [409, 'CONFLICT', GENERIC_MESSAGE],
    [500, undefined, GENERIC_MESSAGE],
  ];
  for (const [status, code, text] of cases) {
    assert.deepEqual(
      teamFailureOf(new ApiError(status, SENTINEL, code)),
      { kind: 'message', text },
      `${String(status)} ${String(code)}`,
    );
  }
  assert.deepEqual(teamFailureOf(new ApiError(401, SENTINEL)), { kind: 'session' });
  assert.deepEqual(teamFailureOf(new ApiError(404, SENTINEL, 'NOT_FOUND')), { kind: 'changed' });
  assert.deepEqual(teamFailureOf(new TypeError(SENTINEL)), {
    kind: 'message',
    text: GENERIC_MESSAGE,
  });
  for (const [, , text] of cases) assert.ok(!text.includes(SENTINEL));
});

test('contratos estritos: campo desconhecido é recusado (a tela falha em vez de exibir)', () => {
  const member = {
    id: randomUUID(),
    email: 'pessoa@example.test',
    role: 'AGENT',
    status: 'ACTIVE',
    createdAt: '2026-11-04T12:00:00.000Z',
  };
  assert.equal(memberSchema.safeParse(member).success, true);
  assert.equal(memberSchema.safeParse({ ...member, accountId: randomUUID() }).success, false);
  assert.equal(memberSchema.safeParse({ ...member, role: 'ROOT' }).success, false);
  const invitation = {
    id: randomUUID(),
    email: 'convidada@example.test',
    role: 'VIEWER',
    state: 'PENDING',
    createdAt: '2026-11-04T12:00:00.000Z',
    expiresAt: '2026-11-11T12:00:00.000Z',
    lastSentAt: '2026-11-04T12:00:00.000Z',
    sendCount: 1,
  };
  assert.equal(invitationSchema.safeParse(invitation).success, true);
  assert.equal(invitationSchema.safeParse({ ...invitation, tokenHash: 'x' }).success, false);
  assert.equal(invitationSchema.safeParse({ ...invitation, role: 'OWNER' }).success, false);
  assert.equal(invitationSchema.safeParse({ ...invitation, sendCount: 7 }).success, false);
});
