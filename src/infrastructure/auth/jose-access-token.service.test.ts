import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import type { AuthIdentity } from '../../application/auth/identity.js';
import { ClientId, PlatformAdminId, UserId } from '../../domain/index.js';
import { ACCESS_TOKEN_TYP, JoseAccessTokenService } from './jose-access-token.service.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0123456789';
const KEY = new TextEncoder().encode(SECRET);
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

const user: AuthIdentity = {
  kind: 'user',
  userId: UserId.parse(randomUUID()),
  clientId: ClientId.parse(randomUUID()),
  role: 'AGENT',
  sessionId: randomUUID(),
};
const platform: AuthIdentity = {
  kind: 'platform',
  adminId: PlatformAdminId.parse(randomUUID()),
  sessionId: randomUUID(),
};

function service(options: { now?: () => Date; tolerance?: number; ttl?: number } = {}) {
  return new JoseAccessTokenService({
    secret: SECRET,
    issuer: 'soprei',
    audience: 'soprei-api',
    ttlSeconds: options.ttl ?? 900,
    clockToleranceSeconds: options.tolerance ?? 5,
    now: options.now ?? (() => new Date(T0)),
  });
}

interface Overrides {
  alg?: string;
  typ?: string | undefined;
  iss?: string;
  aud?: string;
  sub?: string | undefined;
  iat?: number | undefined;
  exp?: number;
  claims?: Record<string, unknown>;
  key?: Uint8Array;
}

/** Monta um token à mão (assinado com HS256 ou com o algoritmo informado) para os casos hostis. */
async function craft(overrides: Overrides = {}): Promise<string> {
  const iat = Math.floor(T0 / 1000);
  const claims = overrides.claims ?? {
    kind: 'user',
    cid: user.kind === 'user' ? user.clientId : '',
    role: 'AGENT',
    sid: user.sessionId,
  };
  let jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: overrides.alg ?? 'HS256',
      ...('typ' in overrides ? { typ: overrides.typ } : { typ: ACCESS_TOKEN_TYP }),
    })
    .setIssuer(overrides.iss ?? 'soprei')
    .setAudience(overrides.aud ?? 'soprei-api')
    .setExpirationTime(overrides.exp ?? iat + 900);
  if (!('sub' in overrides)) jwt = jwt.setSubject(user.kind === 'user' ? user.userId : '');
  else if (overrides.sub !== undefined) jwt = jwt.setSubject(overrides.sub);
  if (!('iat' in overrides)) jwt = jwt.setIssuedAt(iat);
  else if (overrides.iat !== undefined) jwt = jwt.setIssuedAt(overrides.iat);
  return jwt.sign(overrides.key ?? KEY);
}

/** Token com a assinatura trocada por `none`: header e payload de verdade, sem assinatura. */
function unsigned(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(T0 / 1000);
  return `${encode({ alg: 'none', typ: ACCESS_TOKEN_TYP })}.${encode({
    iss: 'soprei',
    aud: 'soprei-api',
    sub: user.kind === 'user' ? user.userId : '',
    iat,
    exp: iat + 900,
    kind: 'user',
    sid: user.sessionId,
  })}.`;
}

describe('JoseAccessTokenService', () => {
  it('emite e verifica o token de User e o de PlatformAdmin, com o expiresIn configurado', async () => {
    const tokens = service();
    for (const identity of [user, platform]) {
      const issued = await tokens.issue(identity);
      assert.equal(issued.expiresIn, 900);
      const verified = await tokens.verify(issued.token);
      assert.ok(verified.ok);
      assert.deepEqual(verified.value.identity, identity);
      assert.equal(verified.value.issuedAt, Math.floor(T0 / 1000));
    }
  });

  it('cabeçalho HS256 com typ at+jwt e claims iss, aud, iat, exp, sub, kind, cid, role e sid', async () => {
    const { token } = await service().issue(user);
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map(
        (part) =>
          JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>,
      );
    assert.deepEqual(header, { alg: 'HS256', typ: 'at+jwt' });
    assert.ok(payload);
    assert.deepEqual(Object.keys(payload).sort(), [
      'aud',
      'cid',
      'exp',
      'iat',
      'iss',
      'kind',
      'role',
      'sid',
      'sub',
    ]);
    assert.equal(payload.exp, Math.floor(T0 / 1000) + 900);
    // O de plataforma não leva cid nem role.
    const platformPayload = JSON.parse(
      Buffer.from(
        (await service().issue(platform)).token.split('.')[1] ?? '',
        'base64url',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    assert.ok(!('cid' in platformPayload) && !('role' in platformPayload));
    assert.equal(platformPayload.kind, 'platform');
  });

  it('um token válido montado à mão passa (os casos hostis abaixo diferem dele em um ponto)', async () => {
    const result = await service().verify(await craft());
    assert.ok(result.ok);
  });

  it('expirado: "expired"; claims erradas, algoritmo trocado ou assinatura inválida: "invalid"', async () => {
    const tokens = service();
    const iat = Math.floor(T0 / 1000);
    const cases: readonly (readonly [string, string, 'expired' | 'invalid'])[] = [
      ['expirado', await craft({ exp: iat - 60 }), 'expired'],
      ['outro iss', await craft({ iss: 'outro' }), 'invalid'],
      ['outro aud', await craft({ aud: 'outra-api' }), 'invalid'],
      ['typ JWT em vez de at+jwt', await craft({ typ: 'JWT' }), 'invalid'],
      ['sem typ', await craft({ typ: undefined }), 'invalid'],
      ['HS384', await craft({ alg: 'HS384' }), 'invalid'],
      ['HS512', await craft({ alg: 'HS512' }), 'invalid'],
      ['alg none', unsigned(), 'invalid'],
      [
        'assinatura de outro segredo',
        await craft({ key: new TextEncoder().encode('x'.repeat(40)) }),
        'invalid',
      ],
      ['sem sub', await craft({ sub: undefined }), 'invalid'],
      ['sem iat', await craft({ iat: undefined }), 'invalid'],
      [
        'sem kind',
        await craft({ claims: { cid: randomUUID(), role: 'AGENT', sid: randomUUID() } }),
        'invalid',
      ],
      [
        'kind desconhecido',
        await craft({ claims: { kind: 'root', sid: randomUUID() } }),
        'invalid',
      ],
      ['sem sid', await craft({ claims: { kind: 'platform' }, sub: randomUUID() }), 'invalid'],
      ['sub que não é UUID', await craft({ sub: 'nao-e-uuid' }), 'invalid'],
      [
        'user sem cid',
        await craft({
          claims: { kind: 'user', role: 'OWNER', sid: randomUUID() },
          sub: randomUUID(),
        }),
        'invalid',
      ],
      [
        'papel desconhecido',
        await craft({
          claims: { kind: 'user', cid: randomUUID(), role: 'ROOT', sid: randomUUID() },
          sub: randomUUID(),
        }),
        'invalid',
      ],
      [
        'platform com cid',
        await craft({
          claims: { kind: 'platform', cid: randomUUID(), sid: randomUUID() },
          sub: randomUUID(),
        }),
        'invalid',
      ],
      ['lixo', 'isto-nao-e-um-jwt', 'invalid'],
      ['vazio', '', 'invalid'],
      ['três partes vazias', '..', 'invalid'],
    ];
    for (const [label, token, expected] of cases) {
      const result = await tokens.verify(token);
      assert.equal(result.ok, false, label);
      assert.equal(result.error, expected, label);
    }
  });

  it('adulterar o payload invalida a assinatura', async () => {
    const { token } = await service().issue(user);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        iss: 'soprei',
        aud: 'soprei-api',
        sub: randomUUID(),
        kind: 'platform',
        sid: randomUUID(),
        iat: Math.floor(T0 / 1000),
        exp: Math.floor(T0 / 1000) + 900,
      }),
    ).toString('base64url');
    const result = await service().verify(`${header ?? ''}.${forged}.${signature ?? ''}`);
    assert.equal(result.ok, false);
  });

  it('clockTolerance aceita token expirado há menos que a tolerância e recusa além dela', async () => {
    const { token } = await service({ ttl: 60 }).issue(user);
    const expiresAt = T0 + 60_000;
    const at = (ms: number) => service({ now: () => new Date(ms), tolerance: 5 });
    assert.ok((await at(expiresAt - 1_000).verify(token)).ok, 'ainda válido');
    assert.ok(
      (await at(expiresAt + 4_000).verify(token)).ok,
      'expirado há 4 s, dentro da tolerância',
    );
    const late = await at(expiresAt + 6_000).verify(token);
    assert.equal(late.ok, false);
    assert.equal(late.error, 'expired', 'expirado há 6 s, além da tolerância');
    const strict = await service({ now: () => new Date(expiresAt + 1_000), tolerance: 0 }).verify(
      token,
    );
    assert.equal(strict.ok, false);
  });

  it('o erro nunca ecoa o token nem o segredo', async () => {
    const result = await service().verify('segredo-aqui.depois.assinatura');
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('segredo-aqui'));
  });
});
