import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ACCOUNT_PATHS, pageForPath, pathForPage } from '../account-flow';
import {
  INVITE_TOKEN_MAX_LENGTH,
  inviteFailureKind,
  invitePreviewSchema,
  parseInviteHash,
  sameEmail,
} from './invite-flow';

const SECRET = 'A'.repeat(43);
const token = (): string => `${randomUUID()}.${randomUUID()}.${SECRET}`;

test('/convite é uma página da conta e abre a jornada do convite', () => {
  assert.equal(pathForPage('invite'), '/convite');
  assert.equal(pageForPath('/convite'), 'invite');
  assert.ok(ACCOUNT_PATHS.includes('/convite'));
});

test('lê o token do fragmento #t=: válido devolve o token', () => {
  const value = token();
  assert.equal(parseInviteHash(`#t=${value}`), value);
  assert.equal(parseInviteHash(`#t=${value.toUpperCase()}`)?.length, value.length);
});

test('fragmento vazio, ausente, malformado, com outros parâmetros ou longo demais não dá token', () => {
  const value = token();
  const invalid = [
    '',
    '#',
    '#t=',
    '#x=abc',
    `#t=${value}&extra=1`,
    `#T=${value}`,
    `t=${value}`,
    `#t=${value}.x`,
    `#t=${value.slice(1)}`,
    `#t=${randomUUID()}.${randomUUID()}.${'A'.repeat(42)}`,
    `#t=${randomUUID()}.nao-uuid.${SECRET}`,
    `#t=${'a'.repeat(INVITE_TOKEN_MAX_LENGTH + 1)}`,
    `#t=${randomUUID()}.${randomUUID()}.${'A'.repeat(300)}`,
  ];
  for (const hash of invalid) assert.equal(parseInviteHash(hash), null, hash.slice(0, 40));
});

test('a falha de qualquer convite é uma só; o texto do servidor nunca importa', () => {
  assert.equal(inviteFailureKind(400, 'INVITATION_INVALID'), 'invalid');
  assert.equal(inviteFailureKind(400, 'VALIDATION_ERROR'), 'policy');
  assert.equal(inviteFailureKind(401, undefined), 'session');
  assert.equal(inviteFailureKind(429, 'RATE_LIMITED'), 'rate');
  assert.equal(inviteFailureKind(503, 'SERVICE_UNAVAILABLE'), 'unavailable');
  assert.equal(inviteFailureKind(500, undefined), 'unavailable');
  assert.equal(inviteFailureKind(undefined, undefined), 'unavailable');
});

test('o preview é estrito: campo desconhecido e papel OWNER são recusados', () => {
  const body = {
    companyName: 'Padaria',
    role: 'AGENT',
    email: 'pessoa@example.test',
    accountState: 'NEW',
  };
  assert.equal(invitePreviewSchema.safeParse(body).success, true);
  assert.equal(invitePreviewSchema.safeParse({ ...body, invitationId: 'x' }).success, false);
  assert.equal(invitePreviewSchema.safeParse({ ...body, role: 'OWNER' }).success, false);
  assert.equal(invitePreviewSchema.safeParse({ ...body, accountState: 'MAYBE' }).success, false);
});

test('comparação do e-mail da sessão com o do convite ignora caixa e espaços', () => {
  assert.equal(sameEmail(' Pessoa@Example.TEST ', 'pessoa@example.test'), true);
  assert.equal(sameEmail('a@example.test', 'b@example.test'), false);
});
