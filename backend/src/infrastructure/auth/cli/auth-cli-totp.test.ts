import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { base32Decode, totpCode, totpStep } from '../../../application/platform/totp.js';
import { createLogger } from '../../logger/logger.js';
import { buildTestAuth, TEST_PASSWORD } from '../../../test-support/in-memory-auth.js';
import { ManualClock, testPlatformCipher } from '../../../test-support/in-memory-platform.js';
import { type AuthCliDeps, runAuthCli } from './auth-cli.js';

const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

function setup(options: { withCipher?: boolean } = {}) {
  const auth = buildTestAuth({ logger: silent });
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const out: string[] = [];
  const err: string[] = [];
  let answer: (printed: readonly string[]) => string = () => '';
  const deps: AuthCliDeps = {
    companies: auth.companies,
    memberships: auth.memberships,
    platformAdmins: auth.platformAdmins,
    hasher: auth.hasher,
    sessions: auth.sessions,
    ...(options.withCipher === false ? {} : { platformCipher: cipher }),
    now: clock.now,
    interactive: false,
    readSecret: () => Promise.resolve(answer(out)),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return {
    auth,
    clock,
    cipher,
    out,
    err,
    deps,
    respond(fn: (printed: readonly string[]) => string) {
      answer = fn;
    },
  };
}

/** O código atual da chave que a CLI imprimiu. */
function codeFromPrinted(printed: readonly string[], nowMs: number, offset = 0): string {
  const line = printed.find((entry) => entry.startsWith('chave para digitar: '));
  assert.ok(line !== undefined, 'a chave foi impressa');
  const secret = base32Decode(line.slice('chave para digitar: '.length));
  assert.ok(secret !== undefined);
  return totpCode(secret, totpStep(nowMs) + offset);
}

async function createAdmin(world: ReturnType<typeof setup>) {
  const email = `p-${randomUUID()}@exemplo.test`;
  const admin = await world.auth.platformAdmins.create({
    email,
    passwordHash: await world.auth.hasher.hash(TEST_PASSWORD),
  });
  return { email, id: admin.id };
}

describe('pnpm auth:cli enroll-platform-totp (spec 044, E1)', () => {
  it('imprime a URI e a chave uma vez, grava cifrado só com código certo e marca o passo como usado', async () => {
    const world = setup();
    const admin = await createAdmin(world);
    world.respond((printed) => codeFromPrinted(printed, world.clock.ms));
    const code = await runAuthCli(['enroll-platform-totp', '--email', admin.email], world.deps);
    assert.equal(code, 0, world.err.join('\n'));
    assert.ok(world.out.some((line) => line.startsWith('otpauth://totp/Soprei:plataforma?')));
    assert.equal(world.out.at(-1), `segundo fator cadastrado: ${admin.id}`);
    assert.equal(world.out.join('\n').includes(admin.email), false);

    const stored = await world.auth.platformAdmins.findTotpSecret(admin.id);
    assert.ok(stored !== null);
    const printedKey = world.out
      .find((line) => line.startsWith('chave para digitar: '))
      ?.slice('chave para digitar: '.length);
    assert.equal(world.cipher.decrypt(admin.id, stored).reveal(), printedKey);
    assert.equal(stored.includes(printedKey ?? '-'), false);
    // O passo do código do cadastro já foi usado: não serve para entrar.
    assert.equal(
      await world.auth.platformAdmins.claimTotpStep(admin.id, totpStep(world.clock.ms)),
      false,
    );
  });

  it('código errado: saída 1 e nada gravado', async () => {
    const world = setup();
    const admin = await createAdmin(world);
    world.respond((printed) => codeFromPrinted(printed, world.clock.ms, 5));
    assert.equal(await runAuthCli(['enroll-platform-totp', '--email', admin.email], world.deps), 1);
    assert.match(world.err.join('\n'), /não confere; nada foi gravado/);
    assert.equal(await world.auth.platformAdmins.findTotpSecret(admin.id), null);
  });

  it('sem as chaves no .env, sem a conta ou com opção estranha: recusa sem gravar', async () => {
    const noCipher = setup({ withCipher: false });
    const admin = await createAdmin(noCipher);
    assert.equal(
      await runAuthCli(['enroll-platform-totp', '--email', admin.email], noCipher.deps),
      1,
    );
    assert.match(noCipher.err.join('\n'), /PLATFORM_TOTP_KEYS/);
    assert.equal(await noCipher.auth.platformAdmins.findTotpSecret(admin.id), null);

    const world = setup();
    assert.equal(
      await runAuthCli(['enroll-platform-totp', '--email', 'ninguem@exemplo.test'], world.deps),
      1,
    );
    assert.equal(
      await runAuthCli(
        ['enroll-platform-totp', '--email', 'a@exemplo.test', '--company', 'x'],
        world.deps,
      ),
      1,
    );
    assert.equal(
      await runAuthCli(
        ['enroll-platform-totp', '--email', 'a@exemplo.test', '--code', '1'],
        world.deps,
      ),
      2,
    );
  });

  it('reset-password --platform-admin apaga também o segundo fator', async () => {
    const world = setup();
    const admin = await createAdmin(world);
    world.respond((printed) => codeFromPrinted(printed, world.clock.ms));
    assert.equal(await runAuthCli(['enroll-platform-totp', '--email', admin.email], world.deps), 0);
    world.respond(() => 'nova-senha-bem-longa-123');
    assert.equal(
      await runAuthCli(['reset-password', '--platform-admin', '--email', admin.email], world.deps),
      0,
    );
    assert.equal(await world.auth.platformAdmins.findTotpSecret(admin.id), null);
    assert.match(world.out.join('\n'), /segundo fator apagado/);
  });
});
