import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLATFORM_SCOPE } from '../../../application/auth/identity.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { captureLogs } from '../../../test-support/log-capture.js';
import { TestKeyspace } from '../../../test-support/test-keyspace.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createRedis, type RedisHandle } from '../../cache/redis.client.js';
import { createDatabase, type Database, PrismaClientRepository } from '../../database/index.js';
import { createAuthRedis, type AuthRedisHandle } from '../auth-redis.js';
import { createAuthComponents } from '../create-auth.js';
import { ScryptPasswordHasher } from '../scrypt-password-hasher.js';
import { type AuthCliDeps, runAuthCli } from './auth-cli.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const PASSWORD = `senha-do-cli-${randomUUID()}`;
const EMAIL_SUFFIX = '@cli-it.test';
const emailFor = (label: string): string =>
  `${label}-${randomBytes(5).toString('hex')}${EMAIL_SUFFIX}`;

let database: Database;
let tenants: TestTenants;
let main: RedisHandle;
let authRedis: AuthRedisHandle;
let prefix: string;
let components: ReturnType<typeof createAuthComponents>;
let tempDir: string;

before(async () => {
  database = createDatabase(config, captureLogs().logger);
  tenants = new TestTenants(database.prisma);
  main = createRedis(config, captureLogs().logger);
  const logs = captureLogs();
  authRedis = createAuthRedis(config, logs.logger);
  assert.ok(await authRedis.waitUntilReady(5_000));
  prefix = keyspace.scopedPrefix(`cli-${randomUUID()}`);
  components = createAuthComponents({
    config: { ...config, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    hasher: new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } }),
  });
  tempDir = mkdtempSync(join(tmpdir(), 'soprei-cli-'));
});

after(async () => {
  try {
    await database.prisma.platformAdmin.deleteMany({
      where: { email: { endsWith: EMAIL_SUFFIX } },
    });
    await tenants.cleanup();
    await keyspace.cleanup(main.client);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await authRedis.close();
    await main.close();
    await database.close();
  }
});

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly prompts: string[];
}

/** Roda o CLI com os serviços reais e uma "digitação" combinada (sem terminal real). */
async function run(
  args: readonly string[],
  secrets: readonly string[],
  interactive = true,
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const queue = [...secrets];
  const deps: AuthCliDeps = {
    clients: new PrismaClientRepository(database.prisma),
    users: components.users,
    platformAdmins: components.platformAdmins,
    hasher: components.hasher,
    sessions: components.sessions,
    interactive,
    readSecret: (label) => {
      prompts.push(label);
      return Promise.resolve(queue.shift() ?? '');
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { code: await runAuthCli(args, deps), out, err, prompts };
}

const idOf = (line: string | undefined): string => {
  const match = /^(?:criado|senha alterada): ([0-9a-f-]{36})$/.exec(line ?? '');
  assert.ok(match?.[1], `saída inesperada: ${line ?? '(vazia)'}`);
  return match[1];
};

describe('pnpm auth:cli (contra soprei_test)', () => {
  it('create-platform-admin grava o hash (nunca a senha), imprime só o id e a senha vale no login', async () => {
    const email = emailFor('plataforma');
    const result = await run(['create-platform-admin', '--email', email], [PASSWORD, PASSWORD]);
    assert.equal(result.code, 0);
    assert.equal(result.out.length, 1);
    const id = idOf(result.out[0]);
    assert.deepEqual(result.prompts, ['Senha: ', 'Repita a senha: ']);
    const stored = await components.platformAdmins.findCredentialsByEmail(email);
    assert.ok(stored);
    assert.equal(stored.admin.id, id);
    assert.ok(stored.passwordHash.startsWith('scrypt$'));
    assert.ok(!stored.passwordHash.includes(PASSWORD));
    assert.equal(await components.hasher.verify(PASSWORD, stored.passwordHash), true);
    // Nada além do id: nem e-mail, nem senha, nem hash na saída.
    const everything = [...result.out, ...result.err].join('\n');
    for (const secret of [email, PASSWORD, stored.passwordHash])
      assert.ok(!everything.includes(secret));
  });

  it('create-user grava no cliente certo, com o papel, e o mesmo e-mail em outro cliente não conflita', async () => {
    const clientA = await tenants.createClient('cli-a');
    const clientB = await tenants.createClient('cli-b');
    const email = emailFor('pessoa');
    const created = await run(
      ['create-user', '--client', clientA.slug, '--email', email, '--role', 'OWNER'],
      [PASSWORD, PASSWORD],
    );
    assert.equal(created.code, 0);
    const id = idOf(created.out[0]);
    const user = await components.users.findCredentialsByEmail(clientA.id, email);
    assert.equal(user?.user.id, id);
    assert.equal(user.user.role, 'OWNER');
    assert.equal(await components.users.findCredentialsByEmail(clientB.id, email), null);
    assert.ok(!JSON.stringify(user).includes(PASSWORD));

    const other = await run(
      ['create-user', '--client', clientB.slug, '--email', email.toUpperCase(), '--role', 'AGENT'],
      [PASSWORD, PASSWORD],
    );
    assert.equal(other.code, 0, 'o mesmo e-mail em outro cliente não conflita');
    assert.equal(
      (await components.users.findCredentialsByEmail(clientB.id, email))?.user.role,
      'AGENT',
    );

    const duplicate = await run(
      ['create-user', '--client', clientA.slug, '--email', email, '--role', 'AGENT'],
      [PASSWORD, PASSWORD],
    );
    assert.equal(duplicate.code, 1);
    assert.deepEqual(duplicate.out, []);
    assert.ok(!duplicate.err.join('\n').includes(email), 'o erro não ecoa o e-mail');
  });

  it('recusa --password (a senha nunca vem por argumento), opção desconhecida e argumentos faltando', async () => {
    const clientA = await tenants.createClient('cli-args');
    const email = emailFor('arg');
    const leaked = 'senha-por-argumento-nao-pode-1';
    for (const args of [
      ['create-platform-admin', '--email', email, '--password', leaked],
      ['create-platform-admin', '--email', email, `--password=${leaked}`],
      [
        'create-user',
        '--client',
        clientA.slug,
        '--email',
        email,
        '--role',
        'OWNER',
        '--password',
        leaked,
      ],
      ['create-platform-admin', '--email', email, '--senha', leaked],
      ['create-platform-admin', 'sobra', '--email', email],
    ]) {
      const result = await run(args, [PASSWORD, PASSWORD]);
      assert.equal(result.code, 2, args.join(' '));
      assert.deepEqual(result.out, []);
      assert.deepEqual(result.prompts, [], 'nem chegou a pedir a senha');
      assert.ok(!result.err.join('\n').includes(leaked));
    }
    assert.equal(await components.platformAdmins.findCredentialsByEmail(email), null);

    for (const args of [
      [],
      ['create-user'],
      ['create-user', '--client', clientA.slug, '--email', email],
      ['create-user', '--client', clientA.slug, '--email', email, '--role', 'ROOT'],
      ['create-user', '--client', 'Slug Inválido!', '--email', email, '--role', 'OWNER'],
      ['create-user', '--client', clientA.slug, '--email', 'nao-e-email', '--role', 'OWNER'],
      ['create-platform-admin'],
      ['create-platform-admin', '--email', email, '--client', clientA.slug],
      ['reset-password', '--email', email],
      ['reset-password', '--platform-admin', '--client', clientA.slug, '--email', email],
      ['inexistente', '--email', email],
    ]) {
      const result = await run(args, [PASSWORD, PASSWORD]);
      assert.notEqual(result.code, 0, args.join(' '));
      assert.deepEqual(result.out, []);
    }
    const unknownClient = await run(
      ['create-user', '--client', 'cliente-que-nao-existe', '--email', email, '--role', 'OWNER'],
      [PASSWORD, PASSWORD],
    );
    assert.equal(unknownClient.code, 1);
  });

  it('senha fora da política (curta, longa, com NUL) e confirmação diferente são recusadas sem criar nada', async () => {
    const clientA = await tenants.createClient('cli-pol');
    for (const bad of ['curta', 'a'.repeat(129), 'senha-com-nul\u0000-valida-1']) {
      const email = emailFor('pol');
      const result = await run(
        ['create-user', '--client', clientA.slug, '--email', email, '--role', 'AGENT'],
        [bad, bad],
      );
      assert.equal(result.code, 1);
      assert.deepEqual(result.out, []);
      assert.equal(await components.users.findCredentialsByEmail(clientA.id, email), null);
      assert.ok(!result.err.join('\n').includes(bad.slice(0, 8)) || bad === 'curta');
    }
    const email = emailFor('conf');
    const mismatch = await run(
      ['create-user', '--client', clientA.slug, '--email', email, '--role', 'AGENT'],
      [PASSWORD, `${PASSWORD}x`],
    );
    assert.equal(mismatch.code, 1);
    assert.equal(await components.users.findCredentialsByEmail(clientA.id, email), null);
    assert.ok(!mismatch.err.join('\n').includes(PASSWORD));
  });

  it('sem terminal: lê só a primeira senha (sem confirmação)', async () => {
    const clientA = await tenants.createClient('cli-pipe');
    const email = emailFor('pipe');
    const result = await run(
      ['create-user', '--client', clientA.slug, '--email', email, '--role', 'AGENT'],
      [PASSWORD],
      false,
    );
    assert.equal(result.code, 0);
    assert.deepEqual(result.prompts, ['Senha: ']);
  });

  it('reset-password troca o hash e revoga todas as sessões (usuário e administrador)', async () => {
    const clientA = await tenants.createClient('cli-reset');
    const email = emailFor('reset');
    const novaSenha = `${PASSWORD}-nova`;
    await run(
      ['create-user', '--client', clientA.slug, '--email', email, '--role', 'OWNER'],
      [PASSWORD, PASSWORD],
    );
    const user = await components.users.findCredentialsByEmail(clientA.id, email);
    assert.ok(user);
    const oldHash = user.passwordHash;

    // Uma sessão viva do usuário, com a mesma conexão e prefixo do CLI.
    const sessionId = randomUUID();
    await components.sessions.createSession({
      scope: clientA.id,
      sessionId,
      subjectId: user.user.id,
      refreshHash: 'a'.repeat(64),
    });
    assert.equal(
      await components.sessions.checkAccess({
        scope: clientA.id,
        sessionId,
        subjectId: user.user.id,
        issuedAt: 1,
      }),
      'ok',
    );

    const result = await run(
      ['reset-password', '--client', clientA.slug, '--email', email],
      [novaSenha, novaSenha],
    );
    assert.equal(result.code, 0);
    assert.equal(idOf(result.out[0]), user.user.id);
    const after = await components.users.findCredentialsByEmail(clientA.id, email);
    assert.notEqual(after?.passwordHash, oldHash);
    assert.equal(await components.hasher.verify(novaSenha, after?.passwordHash ?? ''), true);
    assert.equal(await components.hasher.verify(PASSWORD, after?.passwordHash ?? ''), false);
    assert.equal(
      await components.sessions.checkAccess({
        scope: clientA.id,
        sessionId,
        subjectId: user.user.id,
        issuedAt: 1,
      }),
      'revoked',
      'a sessão foi revogada',
    );

    const adminEmail = emailFor('admin-reset');
    await run(['create-platform-admin', '--email', adminEmail], [PASSWORD, PASSWORD]);
    const admin = await components.platformAdmins.findCredentialsByEmail(adminEmail);
    assert.ok(admin);
    const adminSession = randomUUID();
    await components.sessions.createSession({
      scope: PLATFORM_SCOPE,
      sessionId: adminSession,
      subjectId: admin.admin.id,
      refreshHash: 'b'.repeat(64),
    });
    const adminReset = await run(
      ['reset-password', '--platform-admin', '--email', adminEmail],
      [novaSenha, novaSenha],
    );
    assert.equal(adminReset.code, 0);
    assert.equal(
      await components.sessions.checkAccess({
        scope: PLATFORM_SCOPE,
        sessionId: adminSession,
        subjectId: admin.admin.id,
        issuedAt: 1,
      }),
      'revoked',
    );

    const ghost = await run(
      ['reset-password', '--client', clientA.slug, '--email', emailFor('fantasma')],
      [novaSenha, novaSenha],
    );
    assert.equal(ghost.code, 1);
    assert.deepEqual(ghost.prompts, [], 'conta inexistente: nem pede a senha');
  });

  it('o processo de verdade (pnpm auth:cli): senha pelo stdin sem terminal, só o id na saída, nada em argumento nem em log', () => {
    const email = emailFor('processo');
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const tsx = import.meta.resolve('tsx');
    const { PATH, Path, SystemRoot } = process.env;
    const result = spawnSync(
      process.execPath,
      ['--import', tsx, entry, 'create-platform-admin', '--email', email],
      {
        // Diretório vazio: nenhum .env do desenvolvedor é lido (o ambiente abaixo é o de testes).
        cwd: tempDir,
        env: {
          PATH,
          Path,
          SystemRoot,
          NODE_ENV: 'test',
          DATABASE_URL: config.DATABASE_URL,
          REDIS_URL: config.REDIS_URL,
          JWT_SECRET: config.JWT_SECRET,
          AUTH_REDIS_PREFIX: prefix,
        },
        input: `${PASSWORD}\n`,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^criado: [0-9a-f-]{36}$/);
    const everything = `${result.stdout}${result.stderr}`;
    for (const secret of [PASSWORD, email, config.JWT_SECRET])
      assert.ok(!everything.includes(secret));
  });

  it('o processo de verdade recusa --password antes de tocar no banco', () => {
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const tsx = import.meta.resolve('tsx');
    const { PATH, Path, SystemRoot } = process.env;
    const leaked = 'senha-por-argumento-processo-1';
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        tsx,
        entry,
        'create-platform-admin',
        '--email',
        emailFor('arg'),
        '--password',
        leaked,
      ],
      {
        cwd: tempDir,
        env: {
          PATH,
          Path,
          SystemRoot,
          NODE_ENV: 'test',
          DATABASE_URL: config.DATABASE_URL,
          REDIS_URL: config.REDIS_URL,
          JWT_SECRET: config.JWT_SECRET,
        },
        input: `${PASSWORD}\n`,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(leaked));
  });
});
