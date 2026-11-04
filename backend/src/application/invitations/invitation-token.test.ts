import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { deriveResetKey, resetDigest } from '../auth/reset-code.js';
import { deriveVerificationKey, verificationDigest } from '../auth/verification-code.js';
import {
  buildInvitationLink,
  buildInvitationToken,
  deriveInvitationKey,
  digestsMatch,
  generateInvitationSecret,
  INVITATION_TOKEN_MAX_LENGTH,
  invitationDigest,
  invitationQuotaDigest,
  parseInvitationToken,
} from './invitation-token.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0123456789';

describe('segredo e token do convite (spec 025)', () => {
  it('o segredo tem 256 bits em base64url (43 caracteres) e nunca se repete', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const secret = generateInvitationSecret();
      assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
      seen.add(secret);
    }
    assert.equal(seen.size, 50);
  });

  it('o token é <companyId>.<invitationId>.<segredo> e volta intacto pelo parse', () => {
    const companyId = randomUUID();
    const invitationId = randomUUID();
    const secret = generateInvitationSecret();
    const token = buildInvitationToken(companyId, invitationId, secret);
    assert.match(token, /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(parseInvitationToken(token), { companyId, invitationId, secret });
  });

  it('formatos inválidos dão null: partes a mais ou a menos, ids que não são UUID, segredo curto ou longo, token enorme', () => {
    const companyId = randomUUID();
    const invitationId = randomUUID();
    const secret = generateInvitationSecret();
    const invalid = [
      '',
      'abc',
      `${companyId}.${invitationId}`,
      `${companyId}.${invitationId}.${secret}.x`,
      `x.${invitationId}.${secret}`,
      `${companyId}.y.${secret}`,
      `${companyId}.${invitationId}.${secret.slice(1)}`,
      `${companyId}.${invitationId}.${secret}A`,
      `${companyId}.${invitationId}.${'a'.repeat(INVITATION_TOKEN_MAX_LENGTH)}`,
      `${companyId}.${invitationId}.${secret.slice(0, 42)}!`,
    ];
    for (const token of invalid) assert.equal(parseInvitationToken(token), null, token);
  });

  it('o link usa o fragmento (#t=), nunca a query, e o APP_ORIGIN exatamente como está', () => {
    const link = buildInvitationLink('https://app.exemplo.test', 'a.b.c');
    assert.equal(link, 'https://app.exemplo.test/convite#t=a.b.c');
    assert.ok(!link.includes('?'));
  });

  it('o HMAC é determinístico, depende da chave e do segredo, e só o hash em hex é guardado', () => {
    const key = deriveInvitationKey(SECRET);
    const secret = generateInvitationSecret();
    const digest = invitationDigest(key, secret);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.ok(!digest.includes(secret));
    assert.equal(invitationDigest(key, secret), digest);
    assert.notEqual(
      invitationDigest(key, `${secret.slice(0, 42)}${secret.endsWith('A') ? 'B' : 'A'}`),
      digest,
    );
    assert.notEqual(invitationDigest(deriveInvitationKey(`${SECRET}x`), secret), digest);
  });

  it('a chave tem rótulo próprio: código de confirmação e de recuperação nunca conferem como convite', () => {
    const invitationKey = deriveInvitationKey(SECRET);
    assert.notDeepEqual(invitationKey, deriveVerificationKey(SECRET));
    assert.notDeepEqual(invitationKey, deriveResetKey(SECRET));
    const secret = generateInvitationSecret();
    const stored = invitationDigest(invitationKey, secret);
    // Um digest da 020 ou da 021 com o mesmo "segredo" como código não é o hash do convite.
    assert.notEqual(verificationDigest(deriveVerificationKey(SECRET), 'a@b.test', secret), stored);
    assert.notEqual(resetDigest(deriveResetKey(SECRET), 'a@b.test', secret), stored);
  });

  it('a comparação é em tempo constante e recusa tamanhos diferentes sem lançar', () => {
    const key = deriveInvitationKey(SECRET);
    const digest = invitationDigest(key, generateInvitationSecret());
    assert.equal(digestsMatch(digest, digest), true);
    assert.equal(digestsMatch(digest, digest.slice(1)), false);
    assert.equal(digestsMatch(digest, ''), false);
    assert.equal(digestsMatch(digest, invitationDigest(key, generateInvitationSecret())), false);
  });

  it('a chave de cota é um HMAC por tipo: nunca o e-mail nem o id em claro, e tipos diferentes não colidem', () => {
    const key = deriveInvitationKey(SECRET);
    const recipient = invitationQuotaDigest(key, 'recipient', 'pessoa@exemplo.test');
    const account = invitationQuotaDigest(key, 'account', 'pessoa@exemplo.test');
    assert.match(recipient, /^[0-9a-f]{64}$/);
    assert.ok(!recipient.includes('pessoa'));
    assert.notEqual(recipient, account);
    assert.equal(invitationQuotaDigest(key, 'recipient', 'pessoa@exemplo.test'), recipient);
  });
});
