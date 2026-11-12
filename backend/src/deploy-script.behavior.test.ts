import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';

// Comportamento do deploy/deploy.sh (spec 037, E1): o script de verdade roda com `bash`, num
// repositório Git temporário (com "origin" local) e com dublês de `pm2`, `pnpm` e `curl` no PATH.
// O `git`, o `node` e o `bash` são os reais. Nada toca servidor, rede, banco ou o PM2 da máquina.
//
// O que depende do sistema é pulado COM AVISO (nunca falha em falso): sem `bash`, o arquivo todo; sem
// `flock` real, só o teste da trava (os demais usam um `flock` de mentira que sempre concede); sem
// link simbólico (Windows sem privilégio), só os cenários que chegam à troca do site. No CI (Ubuntu)
// nada disso é pulado.

const REPO_ROOT = join(process.cwd(), '..');
const SCRIPT = join(REPO_ROOT, 'deploy', 'deploy.sh');

const DB_SENTINEL = 'SENTINELA-SENHA-DO-BANCO';
const JWT_SENTINEL = 'SENTINELA-SEGREDO-JWT';

function toPosix(path: string): string {
  if (process.platform !== 'win32') return path;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return drive
    ? `/${(drive[1] ?? '').toLowerCase()}/${(drive[2] ?? '').replaceAll('\\', '/')}`
    : path.replaceAll('\\', '/');
}

function probe(command: string): boolean {
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

const HAS_BASH = probe('true');
const HAS_REAL_FLOCK = HAS_BASH && probe('command -v flock');

function symlinksWork(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'soprei-symlink-probe-'));
  try {
    mkdirSync(join(dir, 'alvo'));
    symlinkSync('alvo', join(dir, 'link'), 'dir');
    return lstatSync(join(dir, 'link')).isSymbolicLink();
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HAS_SYMLINKS = HAS_BASH && symlinksWork();
const BASH_SKIP = HAS_BASH ? false : 'bash não encontrado neste ambiente (o CI tem)';
const FLOCK_SKIP = HAS_REAL_FLOCK ? false : 'flock real não encontrado neste ambiente (o CI tem)';
const SYMLINK_SKIP = HAS_SYMLINKS
  ? false
  : 'link simbólico indisponível neste ambiente (Windows sem privilégio); o CI (Linux) roda este cenário';

if (!HAS_BASH) console.warn(`[deploy-script.behavior] ${BASH_SKIP}`);
else {
  if (!HAS_REAL_FLOCK)
    console.warn(`[deploy-script.behavior] ${FLOCK_SKIP}: o teste da trava será pulado`);
  if (!HAS_SYMLINKS) console.warn(`[deploy-script.behavior] ${SYMLINK_SKIP}`);
}

const STUB_PNPM = `#!/usr/bin/env bash
set -u
echo "pnpm $*" >> "$STUB_DIR/events.log"
case "$*" in
  --version) echo "12.3.4"; exit 0 ;;
  "install --frozen-lockfile")
    n=$(cat "$STUB_DIR/install_count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/install_count"
    if [ -f "$STUB_DIR/install_sleep" ]; then sleep "$(cat "$STUB_DIR/install_sleep")"; fi
    if [ "$(cat "$STUB_DIR/install_fail_on_call" 2>/dev/null || echo 0)" = "$n" ]; then echo "install falhou (dublê)"; exit 1; fi
    exit 0 ;;
  db:generate)
    # Imprime de propósito valores sensíveis: o filtro de redação do script tem de escondê-los.
    echo "DATABASE_URL=\${DATABASE_URL:-}"
    echo "JWT_SECRET=\${LEAK_JWT:-}"
    echo "password=SENTINELA-PW apiKey=SENTINELA-APIKEY Token=SENTINELA-TOKEN"
    echo "conectando em https://usuario:SENTINELA-URLPW@host.invalido/caminho"
    printf '%s' "\${DATABASE_URL:-}" > "$STUB_DIR/db_url_seen_generate"
    exit 0 ;;
  db:migrate:deploy)
    printf '%s' "\${DATABASE_URL:-}" > "$STUB_DIR/db_url_seen_migrate"
    if [ -f "$STUB_DIR/migrate_fail" ]; then echo "migration falhou (dublê)"; exit 1; fi
    exit 0 ;;
esac
out=''
prev=''
for a in "$@"; do
  if [ "$prev" = "--outDir" ]; then out=$a; fi
  prev=$a
done
case "$*" in
  *"exec tsc --noEmit"*) exit 0 ;;
  *"exec tsc -p"*)
    mkdir -p "$out/infrastructure/config"
    sha=$(git -C "$STUB_APP_DIR" rev-parse HEAD)
    echo "// sha=$sha" > "$out/index.js"
    cat > "$out/infrastructure/config/check-cli.js" <<'JS'
const fs = require('node:fs');
if (fs.existsSync(process.env.STUB_DIR + '/config_fail')) {
  console.log('FOO_BAR');
  process.exit(1);
}
console.log('ok');
JS
    exit 0 ;;
  *"exec vite build"*)
    mkdir -p "$out"
    echo "<html>site</html>" > "$out/index.html"
    exit 0 ;;
esac
echo "dublê de pnpm: comando não previsto: $*" >&2
exit 99
`;

const STUB_PM2 = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  jlist)
    if [ -f "$STUB_DIR/pm2_banner" ]; then echo '[PM2] Spawning PM2 daemon (dublê)'; fi
    if [ -f "$STUB_DIR/pm2_absent" ]; then echo '[]'; exit 0; fi
    r=$(cat "$STUB_DIR/pm2_restarts" 2>/dev/null || echo 0)
    if [ -f "$STUB_DIR/loop_bad_sha" ]; then
      cur=$(sed -n 's#^// sha=##p' "$STUB_APP_DIR/backend/dist/index.js" 2>/dev/null)
      if [ "$cur" = "$(cat "$STUB_DIR/loop_bad_sha")" ]; then r=$((r + 1)); echo "$r" > "$STUB_DIR/pm2_restarts"; fi
    fi
    echo "[{\\"name\\":\\"$PM2_APP_NAME\\",\\"pm2_env\\":{\\"status\\":\\"online\\",\\"restart_time\\":$r}}]"
    exit 0 ;;
  startOrReload)
    echo "pm2 $*" >> "$STUB_DIR/events.log"
    if [ -f "$STUB_DIR/pm2_reload_fail" ]; then exit 1; fi
    exit 0 ;;
esac
echo "pm2 $*" >> "$STUB_DIR/events.log"
exit 0
`;

const STUB_CURL = `#!/usr/bin/env bash
url=''
for a in "$@"; do url=$a; done
case "$url" in
  */health*)
    if [ -f "$STUB_DIR/health_down" ]; then printf 000; exit 7; fi
    cur=$(sed -n 's#^// sha=##p' "$STUB_APP_DIR/backend/dist/index.js" 2>/dev/null)
    if [ -f "$STUB_DIR/health_bad_sha" ] && [ "$cur" = "$(cat "$STUB_DIR/health_bad_sha")" ]; then printf 503; else printf 200; fi ;;
  *)
    # O site só responde 200 se o frontend/dist (atalho ou pasta) existe de verdade.
    if [ -n "\${SITE_CODE:-}" ]; then printf '%s' "$SITE_CODE"
    elif [ -f "$STUB_APP_DIR/frontend/dist/index.html" ]; then printf 200
    else printf 404; fi ;;
esac
`;

const STUB_FLOCK = `#!/usr/bin/env bash
exit 0
`;

const STUB_BACKUP = `#!/usr/bin/env bash
echo "backup" >> "$STUB_DIR/events.log"
if [ -f "$STUB_DIR/backup_fail" ]; then exit 1; fi
exit 0
`;

type EnvName = 'staging' | 'production';

interface World {
  root: string;
  env: EnvName;
  appDir: string;
  workDir: string;
  stubDir: string;
  stateDir: string;
  logDir: string;
  targetsDir: string;
  lockFile: string;
  prevSha: string;
  targetSha: string;
  logFile: string;
}

interface WorldOptions {
  env?: EnvName;
  targetMigration?: string; // conteúdo do migration.sql que o commit-alvo adiciona
  withBackup?: boolean;
  registerState?: boolean;
}

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Teste',
      '-c',
      'user.email=teste@exemplo.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function write(path: string, content: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
}

function makeWorld(options: WorldOptions = {}): World {
  const env = options.env ?? 'staging';
  const root = mkdtempSync(join(tmpdir(), 'soprei-deploy-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const workDir = join(root, 'work');
  const appDir = join(root, 'app');
  const stubDir = join(root, 'stub');
  const stateDir = join(root, 'state');
  const logDir = join(root, 'logs');
  const targetsDir = join(root, 'targets');
  for (const dir of [stubDir, stateDir, logDir, targetsDir, workDir])
    mkdirSync(dir, { recursive: true });

  git(root, 'init', '--bare', '-b', 'main', origin);
  git(workDir, 'init', '-b', 'main');
  write(join(workDir, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8'));
  write(join(workDir, '.nvmrc'), `${process.versions.node.split('.')[0] ?? ''}\n`);
  write(
    join(workDir, 'package.json'),
    '{"name":"w","private":true,"packageManager":"pnpm@12.3.4"}\n',
  );
  write(join(workDir, 'backend', 'package.json'), '{"name":"soprei-backend","private":true}\n');
  write(
    join(workDir, 'backend', 'prisma', 'migrations', '20260101000000_init', 'migration.sql'),
    'CREATE TABLE t (id int);\n',
  );
  write(join(workDir, 'frontend', 'package.json'), '{"name":"soprei-frontend","private":true}\n');
  write(join(workDir, 'deploy', 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
  git(workDir, 'add', '-A');
  git(workDir, 'commit', '-m', 'versao anterior');
  git(workDir, 'remote', 'add', 'origin', origin);
  git(workDir, 'push', '-q', 'origin', 'main');
  const prevSha = git(workDir, 'rev-parse', 'HEAD');

  git(root, 'clone', '-q', origin, appDir);

  write(join(workDir, 'backend', 'src.txt'), 'novo\n');
  if (options.targetMigration !== undefined) {
    write(
      join(workDir, 'backend', 'prisma', 'migrations', '20261111000000_nova', 'migration.sql'),
      options.targetMigration,
    );
  }
  git(workDir, 'add', '-A');
  git(workDir, 'commit', '-m', 'versao nova');
  git(workDir, 'push', '-q', 'origin', 'main');
  const targetSha = git(workDir, 'rev-parse', 'HEAD');

  // O que existe só no servidor (fora do Git): o .env, a compilação e o site em uso.
  write(
    join(appDir, 'backend', '.env'),
    `export DATABASE_URL=postgresql://soprei:${DB_SENTINEL}@127.0.0.1:5432/soprei_test  # banco de teste\nJWT_SECRET=${JWT_SENTINEL}\n`,
    0o600,
  );
  chmodSync(join(appDir, 'backend', '.env'), 0o600);
  write(join(appDir, 'backend', 'dist', 'index.js'), `// sha=${prevSha}\n`);
  write(join(appDir, 'frontend', 'dist', 'index.html'), '<html>legado</html>\n');

  const appName = env === 'production' ? 'soprei-api' : 'soprei-staging';
  const conf = [
    `APP_DIR=${toPosix(appDir)}`,
    `ENV_FILE=${toPosix(join(appDir, 'backend', '.env'))}`,
    `PM2_APP=${appName}`,
    'PORT=39999',
    'HEALTH_URL=http://127.0.0.1:39999/health',
    'READY_URL=http://127.0.0.1:39999/health/ready',
    'SITE_HOST=app.teste.invalid',
    'SITE_OK_CODES=200',
    `REQUIRE_STAGED=${env === 'production' ? 'true' : 'false'}`,
    ...(options.withBackup === true
      ? [`PRE_MIGRATION_BACKUP=${toPosix(join(stubDir, 'backup'))}`]
      : []),
    'HEALTH_TIMEOUT_SECONDS=6',
    'HEALTH_INTERVAL_SECONDS=0.1',
    'HEALTH_STABLE_COUNT=3',
    'MIGRATE_TIMEOUT_SECONDS=30',
    'MIN_FREE_KB=1024',
    'BUILD_MEMORY_MB=256',
    '',
  ].join('\n');
  write(join(targetsDir, `${env}.conf`), conf);

  write(join(stubDir, 'pnpm'), STUB_PNPM, 0o755);
  write(join(stubDir, 'pm2'), STUB_PM2, 0o755);
  write(join(stubDir, 'curl'), STUB_CURL, 0o755);
  write(join(stubDir, 'backup'), STUB_BACKUP, 0o755);
  if (!HAS_REAL_FLOCK) write(join(stubDir, 'flock'), STUB_FLOCK, 0o755);

  if (options.registerState !== false) {
    write(join(stateDir, env, 'current'), `${prevSha}\n`);
  }

  return {
    root,
    env,
    appDir,
    workDir,
    stubDir,
    stateDir,
    logDir,
    targetsDir,
    lockFile: join(root, 'deploy.lock'),
    prevSha,
    targetSha,
    logFile: join(logDir, `${env}.log`),
  };
}

function scriptEnv(world: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const basePath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_OPTIONS'];
  delete env['Path'];
  env['PATH'] = `${world.stubDir}${delimiter}${basePath}`;
  env['SOPREI_DEPLOY_LOCK_FILE'] = toPosix(world.lockFile);
  env['SOPREI_DEPLOY_STATE_DIR'] = toPosix(world.stateDir);
  env['SOPREI_DEPLOY_LOG_DIR'] = toPosix(world.logDir);
  env['SOPREI_DEPLOY_TARGETS_DIR'] = toPosix(world.targetsDir);
  env['STUB_DIR'] = toPosix(world.stubDir);
  env['STUB_APP_DIR'] = toPosix(world.appDir);
  env['PM2_APP_NAME'] = world.env === 'production' ? 'soprei-api' : 'soprei-staging';
  env['LEAK_JWT'] = JWT_SENTINEL;
  return env;
}

interface RunResult {
  status: number | null;
  out: string;
  log: string;
  events: string;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function finish(world: World, status: number | null, out: string): RunResult {
  return {
    status,
    out,
    log: readIfExists(world.logFile),
    // `pnpm --version` é só a conferência de pré-condição: não conta como "mexeu em algo".
    events: readIfExists(join(world.stubDir, 'events.log'))
      .split('\n')
      .filter((line) => line !== 'pnpm --version')
      .join('\n'),
  };
}

function deploy(world: World, args: string[], extra: Record<string, string> = {}): RunResult {
  const result = spawnSync('bash', [toPosix(SCRIPT), ...args], {
    cwd: world.appDir,
    env: scriptEnv(world, extra),
    encoding: 'utf8',
    timeout: 90_000,
  });
  return finish(world, result.status, `${result.stdout}${result.stderr}`);
}

function head(world: World): string {
  return git(world.appDir, 'rev-parse', 'HEAD');
}

function stateOf(world: World, file: 'current' | 'previous', env: EnvName = world.env): string {
  return readIfExists(join(world.stateDir, env, file)).trim();
}

function setStub(world: World, name: string, content = '1'): void {
  writeFileSync(join(world.stubDir, name), content);
}

function assertNoSecrets(result: RunResult): void {
  for (const secret of [
    DB_SENTINEL,
    JWT_SENTINEL,
    'SENTINELA-PW',
    'SENTINELA-APIKEY',
    'SENTINELA-TOKEN',
    'SENTINELA-URLPW',
  ]) {
    assert.ok(!result.out.includes(secret), `a saída contém o segredo ${secret}`);
    assert.ok(!result.log.includes(secret), `o log contém o segredo ${secret}`);
  }
}

function indexOfEvent(events: string, text: string): number {
  return events.split('\n').findIndex((line) => line.includes(text));
}

const ADDITIVE = 'ALTER TABLE t ADD COLUMN nova text;\n';

describe('deploy.sh: recusas antes de mexer (saída 1)', { skip: BASH_SKIP }, () => {
  it('exige --env e recusa ambiente desconhecido', () => {
    const world = makeWorld();
    const semEnv = deploy(world, ['--dry-run']);
    assert.equal(semEnv.status, 1);
    assert.match(semEnv.out, /--env é obrigatório/);
    const desconhecido = deploy(world, ['--env', 'homologacao']);
    assert.equal(desconhecido.status, 1);
    assert.equal(head(world), world.prevSha);
  });

  it('--inject-health-failure é recusado fora do staging e --allow-unstaged fora da produção', () => {
    const production = makeWorld({ env: 'production' });
    const inject = deploy(production, ['--env', 'production', '--inject-health-failure']);
    assert.equal(inject.status, 1);
    assert.match(inject.out, /só é aceito com --env staging/);
    const staging = makeWorld();
    const unstaged = deploy(staging, ['--env', 'staging', '--allow-unstaged']);
    assert.equal(unstaged.status, 1);
  });

  it('(e) migration com DROP COLUMN sem a marca bloqueia antes de qualquer mudança', () => {
    const world = makeWorld({ targetMigration: 'ALTER TABLE t DROP COLUMN velha;\n' });
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /20261111000000_nova/);
    assert.match(result.out, /breaking-approved/);
    assert.equal(head(world), world.prevSha);
    assert.equal(result.events, '', 'nenhum pnpm, pm2 ou backup pode ter rodado');
    assert.equal(stateOf(world, 'current'), world.prevSha);
    assertNoSecrets(result);
  });

  it('migration marcada como destrutiva exige --allow-breaking', () => {
    const world = makeWorld({
      targetMigration:
        '-- breaking-approved: coluna sem uso desde a versão anterior\nALTER TABLE t DROP COLUMN velha;\n',
    });
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /--allow-breaking/);
    assert.equal(result.events, '');
  });

  it('migration destrutiva em produção exige PRE_MIGRATION_BACKUP no alvo', () => {
    const world = makeWorld({
      env: 'production',
      targetMigration: '-- breaking-approved: motivo\nALTER TABLE t DROP COLUMN velha;\n',
    });
    write(join(world.stateDir, 'staging', 'current'), `${world.targetSha}\n`);
    const result = deploy(world, [
      '--env',
      'production',
      '--ref',
      world.targetSha,
      '--allow-breaking',
    ]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /PRE_MIGRATION_BACKUP/);
    assert.equal(result.events, '');
  });

  it('(i) HEAD diferente do estado registrado recusa e manda usar --force', () => {
    const world = makeWorld();
    write(join(world.stateDir, 'staging', 'current'), `${world.targetSha}\n`);
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /--force/);
    assert.equal(head(world), world.prevSha);
    assert.equal(result.events, '');
  });

  it('sem versão registrada recusa sem --adopt; o dry-run avisa e segue', () => {
    const world = makeWorld({ registerState: false });
    const real = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(real.status, 1);
    assert.match(real.out, /--adopt/);
    const dry = deploy(world, ['--env', 'staging', '--ref', world.targetSha, '--dry-run']);
    assert.equal(dry.status, 0, dry.out);
    assert.equal(stateOf(world, 'current'), '', 'o dry-run não registra nada');
  });

  it(
    'árvore suja, .env com modo errado e app ausente no PM2 recusam',
    { skip: process.platform === 'win32' ? 'modo de arquivo não é fiel no Windows' : false },
    () => {
      const dirty = makeWorld();
      write(join(dirty.appDir, 'sujeira.txt'), 'x');
      const r1 = deploy(dirty, ['--env', 'staging', '--ref', dirty.targetSha]);
      assert.equal(r1.status, 1);
      assert.match(r1.out, /não está limpa/);

      const mode = makeWorld();
      chmodSync(join(mode.appDir, 'backend', '.env'), 0o644);
      const r2 = deploy(mode, ['--env', 'staging', '--ref', mode.targetSha]);
      assert.equal(r2.status, 1);
      assert.match(r2.out, /modo 600/);

      const absent = makeWorld();
      setStub(absent, 'pm2_absent');
      const r3 = deploy(absent, ['--env', 'staging', '--ref', absent.targetSha]);
      assert.equal(r3.status, 1);
      assert.match(r3.out, /não existe no PM2/);
    },
  );

  it('(j) produção com SHA diferente do staging recusa sem --allow-unstaged', () => {
    const world = makeWorld({ env: 'production' });
    write(join(world.stateDir, 'staging', 'current'), `${world.prevSha}\n`);
    const refused = deploy(world, ['--env', 'production', '--ref', world.targetSha]);
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /só aceita o SHA que já está no staging/);
    assert.equal(refused.events, '');

    const allowed = deploy(world, [
      '--env',
      'production',
      '--ref',
      world.targetSha,
      '--allow-unstaged',
      '--dry-run',
    ]);
    assert.equal(allowed.status, 0, allowed.out);
    assert.match(allowed.out, /--allow-unstaged/);

    write(join(world.stateDir, 'staging', 'current'), `${world.targetSha}\n`);
    const staged = deploy(world, ['--env', 'production', '--ref', world.targetSha, '--dry-run']);
    assert.equal(staged.status, 0, staged.out);
  });

  it('adoção de ambiente novo (app ausente no PM2) implanta mesmo sendo o mesmo SHA', () => {
    const world = makeWorld({ registerState: false });
    setStub(world, 'pm2_absent');
    const result = deploy(world, [
      '--env',
      'staging',
      '--ref',
      world.prevSha,
      '--adopt',
      '--dry-run',
    ]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /PLANO/);
    assert.doesNotMatch(result.out, /já está nessa versão/);
    assert.equal(stateOf(world, 'current'), '', 'o dry-run não registra nada');
  });

  it('adoção de servidor já atualizado à mão (mesmo SHA, app no ar) registra a versão sem implantar', () => {
    const world = makeWorld({ registerState: false });
    const dry = deploy(world, ['--env', 'staging', '--ref', world.prevSha, '--adopt', '--dry-run']);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /o deploy real registraria/);
    assert.equal(stateOf(world, 'current'), '', 'o dry-run não registra nada');

    const real = deploy(world, ['--env', 'staging', '--ref', world.prevSha, '--adopt']);
    assert.equal(real.status, 0, real.out);
    assert.match(real.out, /versão em execução registrada \(adoção\)/);
    assert.match(real.out, /já está nessa versão/);
    assert.equal(stateOf(world, 'current'), world.prevSha);
    assert.equal(real.events, '', 'nada foi instalado, compilado nem recarregado');

    // Depois da adoção, o deploy seguinte não recusa por falta de versão registrada.
    const next = deploy(world, ['--env', 'staging', '--ref', world.targetSha, '--dry-run']);
    assert.equal(next.status, 0, next.out);
    assert.doesNotMatch(next.out, /nenhuma versão registrada/);
  });

  it('mesmo SHA sai com 0 ("já está nessa versão") e não instala nada', () => {
    const world = makeWorld();
    const result = deploy(world, ['--env', 'staging', '--ref', world.prevSha]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /já está nessa versão/);
    assert.equal(result.events, '');
  });
});

describe('deploy.sh: --dry-run', { skip: BASH_SKIP }, () => {
  it('(b) sai com 0, imprime o plano e não altera HEAD, estado nem chama pnpm install', () => {
    const world = makeWorld({ targetMigration: ADDITIVE });
    setStub(world, 'pm2_banner'); // o PM2 às vezes imprime avisos antes do JSON
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha, '--dry-run']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /PLANO/);
    assert.match(result.out, /20261111000000_nova: aditiva/);
    assert.match(result.out, /DRY-RUN concluído/);
    assert.match(result.out, /PM2 soprei-staging: online/);
    assert.equal(head(world), world.prevSha);
    assert.equal(stateOf(world, 'current'), world.prevSha);
    assert.equal(stateOf(world, 'previous'), '');
    assert.ok(!result.events.includes('install'), result.events);
    assert.ok(!result.events.includes('startOrReload'));
    assertNoSecrets(result);
  });
});

describe(
  'deploy.sh: falhas antes da troca (saída 2, processo intacto)',
  { skip: BASH_SKIP },
  () => {
    it('(f) config:check falho barra antes da migration e do reload, e restaura o HEAD', () => {
      const world = makeWorld({ targetMigration: ADDITIVE });
      setStub(world, 'config_fail');
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      assert.equal(result.status, 2, result.out);
      assert.match(result.out, /FOO_BAR/);
      assert.match(result.out, /nenhuma migration foi aplicada/);
      assert.ok(!result.events.includes('db:migrate:deploy'), result.events);
      assert.ok(!result.events.includes('startOrReload'), result.events);
      assert.equal(head(world), world.prevSha, 'a árvore volta à versão anterior');
      assert.equal(stateOf(world, 'current'), world.prevSha);
      assert.equal(
        readFileSync(join(world.appDir, 'backend', 'dist', 'index.js'), 'utf8').trim(),
        `// sha=${world.prevSha}`,
      );
      assert.ok(!existsSync(join(world.appDir, 'backend', 'dist.next')));
      // "export" e comentário no fim do .env não entram no valor entregue ao comando.
      assert.equal(
        readFileSync(join(world.stubDir, 'db_url_seen_generate'), 'utf8'),
        `postgresql://soprei:${DB_SENTINEL}@127.0.0.1:5432/soprei_test`,
      );
      assertNoSecrets(result);
    });

    it('migration que falha não troca nada e restaura a árvore (saída 2) com o aviso de migration parcial', () => {
      const world = makeWorld({ targetMigration: ADDITIVE });
      setStub(world, 'migrate_fail');
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      assert.equal(result.status, 2, result.out);
      assert.match(result.out, /migration parcial/);
      assert.ok(!result.events.includes('startOrReload'));
      assert.equal(head(world), world.prevSha);
    });

    it('backup falho antes da migration não migra', () => {
      const world = makeWorld({ targetMigration: ADDITIVE, withBackup: true });
      setStub(world, 'backup_fail');
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      assert.equal(result.status, 2, result.out);
      assert.ok(result.events.includes('backup'));
      assert.ok(!result.events.includes('db:migrate:deploy'));
      assert.equal(head(world), world.prevSha);
    });

    it('instalação que falha restaura a árvore e sai com 2', () => {
      const world = makeWorld();
      setStub(world, 'install_fail_on_call', '1');
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      // A restauração também reinstala (chamada 2, que passa); o processo nunca foi tocado.
      assert.equal(result.status, 2, result.out);
      assert.ok(!result.events.includes('startOrReload'));
      assert.equal(head(world), world.prevSha);
    });
  },
);

describe('deploy.sh: falha de saúde e rollback', { skip: BASH_SKIP }, () => {
  it('(c) falha de saúde provoca o rollback, restaura o HEAD, sai com 2 e lista as migrations não revertidas', () => {
    const world = makeWorld({ targetMigration: ADDITIVE });
    setStub(world, 'health_bad_sha', world.targetSha);
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(result.status, 2, result.out);
    assert.match(result.out, /DEPLOY FALHOU; VOLTEI PARA/);
    assert.match(result.out, /20261111000000_nova/);
    assert.match(result.out, /NÃO revertidas/);
    assert.equal(head(world), world.prevSha);
    assert.equal(stateOf(world, 'current'), world.prevSha);
    assert.equal(
      readFileSync(join(world.appDir, 'backend', 'dist', 'index.js'), 'utf8').trim(),
      `// sha=${world.prevSha}`,
    );
    assert.equal(
      result.events.split('\n').filter((line) => line.includes('startOrReload')).length,
      2,
      'recarregou na troca e na volta',
    );
    assert.ok(
      indexOfEvent(result.events, 'db:migrate:deploy') <
        indexOfEvent(result.events, 'startOrReload'),
    );
    // Depois de voltar, a lista do PM2 é gravada (e só depois do último reload).
    const lines = result.events.split('\n');
    const lastReload = lines.map((line) => line.includes('startOrReload')).lastIndexOf(true);
    assert.ok(indexOfEvent(result.events, 'pm2 save') > lastReload, result.events);
    assertNoSecrets(result);
  });

  it('--inject-health-failure no staging prova o rollback sem estragar nada', () => {
    const world = makeWorld();
    const result = deploy(world, [
      '--env',
      'staging',
      '--ref',
      world.targetSha,
      '--inject-health-failure',
    ]);
    assert.equal(result.status, 2, result.out);
    assert.match(result.out, /INJETADA/);
    assert.match(result.out, /VOLTEI PARA/);
    assert.equal(head(world), world.prevSha);
    assert.equal(stateOf(world, 'current'), world.prevSha);
  });

  it('laço de reinício (restart_time cresce) falha mesmo que a saúde responda 200', () => {
    const world = makeWorld();
    setStub(world, 'loop_bad_sha', world.targetSha);
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(result.status, 2, result.out);
    assert.match(result.out, /laço de reinício/);
    assert.equal(head(world), world.prevSha);
  });

  it('(d) falha do rollback sai com 3 e pede intervenção manual', () => {
    const world = makeWorld({ targetMigration: ADDITIVE });
    setStub(world, 'health_bad_sha', world.targetSha);
    // Chamadas de install: 1 = a do deploy, 2 = a do rollback (falha de propósito).
    setStub(world, 'install_fail_on_call', '2');
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(result.status, 3, result.out);
    assert.match(result.out, /INTERVENÇÃO MANUAL/);
    assert.match(result.out, /20261111000000_nova/);
    assert.match(result.out, /não tenta de novo/);
    assertNoSecrets(result);
  });

  it('--allow-breaking não faz rollback automático (saída 3, o HEAD fica na versão nova)', () => {
    const world = makeWorld({
      targetMigration: '-- breaking-approved: motivo de teste\nALTER TABLE t DROP COLUMN velha;\n',
    });
    setStub(world, 'health_bad_sha', world.targetSha);
    const result = deploy(world, [
      '--env',
      'staging',
      '--ref',
      world.targetSha,
      '--allow-breaking',
    ]);
    assert.equal(result.status, 3, result.out);
    assert.match(result.out, /não há rollback automático/);
    assert.equal(head(world), world.targetSha);
    assert.equal(
      result.events.split('\n').filter((line) => line.includes('startOrReload')).length,
      1,
    );
  });
});

describe('deploy.sh: deploy concluído e redação de segredos', { skip: BASH_SKIP }, () => {
  it(
    '(a)(h) conclui com 0, grava o estado, troca o site por atalho e nada secreto vai à saída nem ao log',
    { skip: SYMLINK_SKIP },
    () => {
      const world = makeWorld({ targetMigration: ADDITIVE, withBackup: true });
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      assert.equal(result.status, 0, result.out);
      assert.match(result.out, /RESUMO: concluído/);
      assert.match(result.out, /indisponibilidade medida/);
      assert.match(result.out, /20261111000000_nova/);
      assert.equal(head(world), world.targetSha);
      assert.equal(stateOf(world, 'current'), world.targetSha);
      assert.equal(stateOf(world, 'previous'), world.prevSha);
      assert.equal(
        readFileSync(join(world.appDir, 'backend', 'dist', 'index.js'), 'utf8').trim(),
        `// sha=${world.targetSha}`,
      );
      const link = join(world.appDir, 'frontend', 'dist');
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.match(readlinkSync(link), /^releases\/[0-9a-f]{12}-\d{14}$/);
      assert.ok(
        readdirSync(join(world.appDir, 'frontend', 'releases')).some((name) =>
          name.startsWith('legacy-'),
        ),
      );

      // O nginx (outro usuário) precisa ler o site: o umask 077 do script não pode vazar para a release.
      const releasesDir = join(world.appDir, 'frontend', 'releases');
      assert.equal(statSync(releasesDir).mode & 0o755, 0o755, 'releases/ precisa de 755');
      for (const name of readdirSync(releasesDir)) {
        assert.equal(
          statSync(join(releasesDir, name)).mode & 0o055,
          0o055,
          `${name} ilegível para o grupo e outros`,
        );
      }
      const release = readdirSync(releasesDir).find((name) => /^[0-9a-f]{12}-/.test(name)) ?? '';
      assert.equal(statSync(join(releasesDir, release, 'index.html')).mode & 0o044, 0o044);

      // Ordem: backup, migration, depois o reload.
      const backup = indexOfEvent(result.events, 'backup');
      const migrate = indexOfEvent(result.events, 'db:migrate:deploy');
      const reload = indexOfEvent(result.events, 'startOrReload');
      assert.ok(backup >= 0 && backup < migrate && migrate < reload, result.events);
      // A lista do PM2 é gravada depois do reload (o servidor volta com esta configuração se reiniciar).
      assert.ok(indexOfEvent(result.events, 'pm2 save') > reload, result.events);

      // A URL do banco chegou aos comandos que precisam dela, mas nunca foi impressa.
      const dbUrl = `postgresql://soprei:${DB_SENTINEL}@127.0.0.1:5432/soprei_test`;
      assert.equal(readFileSync(join(world.stubDir, 'db_url_seen_generate'), 'utf8'), dbUrl);
      assert.equal(readFileSync(join(world.stubDir, 'db_url_seen_migrate'), 'utf8'), dbUrl);
      assert.match(result.out, /\[redacted\]/, 'o filtro agiu sobre o que o dublê imprimiu');
      assertNoSecrets(result);
      assert.ok(result.log.includes('RESUMO'), 'o log recebe os mesmos eventos');
    },
  );

  it(
    'segundo deploy no mesmo ambiente reaproveita o atalho do site (legado vira release uma vez só)',
    { skip: SYMLINK_SKIP },
    () => {
      const world = makeWorld();
      const first = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      assert.equal(first.status, 0, first.out);
      const second = deploy(world, ['--env', 'staging', '--ref', world.prevSha]);
      assert.equal(second.status, 0, second.out);
      assert.equal(head(world), world.prevSha);
      assert.equal(stateOf(world, 'current'), world.prevSha);
      assert.equal(stateOf(world, 'previous'), world.targetSha);
    },
  );

  it('--previous volta ao SHA anterior registrado', { skip: SYMLINK_SKIP }, () => {
    const world = makeWorld();
    assert.equal(deploy(world, ['--env', 'staging', '--ref', world.targetSha]).status, 0);
    const back = deploy(world, ['--env', 'staging', '--previous']);
    assert.equal(back.status, 0, back.out);
    assert.equal(head(world), world.prevSha);
  });

  it(
    'site que não responde depois da troca restaura o atalho e faz o rollback',
    { skip: SYMLINK_SKIP },
    () => {
      const world = makeWorld();
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha], {
        SITE_CODE: '502',
      });
      assert.equal(result.status, 2, result.out);
      assert.match(result.out, /site restaurado/);
      assert.equal(head(world), world.prevSha);
      // Na primeira vez a pasta real é movida e, no rollback, devolvida ao lugar (não vira atalho).
      const dist = join(world.appDir, 'frontend', 'dist');
      assert.ok(!lstatSync(dist).isSymbolicLink());
      assert.match(readFileSync(join(dist, 'index.html'), 'utf8'), /legado/);
    },
  );
});

const STUB_MV = `#!/usr/bin/env bash
# Falha de propósito quando os argumentos contêm MV_FAIL_SUBSTR; senão chama o mv de verdade.
if [ -n "\${MV_FAIL_SUBSTR:-}" ] && [[ " $* " == *"$MV_FAIL_SUBSTR"* ]]; then
  echo "mv falhou (dublê): $*" >&2
  exit 1
fi
exec /usr/bin/mv "$@"
`;

describe('deploy.sh: falhas de troca, recuperação e alvo', { skip: BASH_SKIP }, () => {
  it('I3/S7: mv que falha na troca do dist não vira "troca concluída" e o app antigo segue no ar (saída 2)', () => {
    const world = makeWorld({ targetMigration: ADDITIVE });
    write(join(world.stubDir, 'mv'), STUB_MV, 0o755);
    // dist.prev residual de uma execução anterior.
    write(join(world.appDir, 'backend', 'dist.prev', 'lixo.txt'), 'x');
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha], {
      MV_FAIL_SUBSTR: ' dist dist.prev',
    });
    assert.equal(result.status, 2, result.out);
    assert.match(result.out, /o processo em execução não foi tocado/);
    assert.match(result.out, /20261111000000_nova/);
    assert.ok(!result.events.includes('startOrReload'), 'nada foi recarregado');
    assert.equal(head(world), world.prevSha);
    const dist = join(world.appDir, 'backend', 'dist');
    assert.equal(readFileSync(join(dist, 'index.js'), 'utf8').trim(), `// sha=${world.prevSha}`);
    assert.ok(
      !existsSync(join(dist, 'dist.next')),
      'a pasta nova não pode ter ido para dentro do dist',
    );
    assert.ok(!existsSync(join(world.appDir, 'backend', 'dist.next')));
    assert.equal(stateOf(world, 'current'), world.prevSha);
    assertNoSecrets(result);
  });

  it('I2: falha na troca do site na primeira vez devolve a pasta frontend/dist', () => {
    const world = makeWorld();
    write(join(world.stubDir, 'mv'), STUB_MV, 0o755);
    const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha], {
      MV_FAIL_SUBSTR: '.dist.new',
    });
    assert.equal(result.status, 2, result.out);
    assert.match(result.out, /site restaurado/);
    const dist = join(world.appDir, 'frontend', 'dist');
    assert.ok(existsSync(join(dist, 'index.html')), 'frontend/dist precisa existir de novo');
    assert.ok(!lstatSync(dist).isSymbolicLink());
    assert.match(readFileSync(join(dist, 'index.html'), 'utf8'), /legado/);
    assert.ok(!existsSync(join(world.appDir, 'frontend', '.dist.new')));
    assert.equal(head(world), world.prevSha);
  });

  it('I1: HEAD diferente do registrado: recusa sem --force; com --force o plano segue e avisa', () => {
    const world = makeWorld();
    git(world.appDir, 'fetch', '-q', 'origin');
    git(world.appDir, 'checkout', '-q', '--detach', world.targetSha); // execução que morreu no meio
    const refused = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /--force/);
    const forced = deploy(world, [
      '--env',
      'staging',
      '--ref',
      world.targetSha,
      '--force',
      '--dry-run',
    ]);
    assert.equal(forced.status, 0, forced.out);
    assert.match(forced.out, /seguindo por causa do --force/);
    assert.match(forced.out, /PLANO/);
  });

  it(
    'I1: a recuperação com --force reimplanta e reconcilia o estado',
    { skip: SYMLINK_SKIP },
    () => {
      const world = makeWorld();
      git(world.appDir, 'fetch', '-q', 'origin');
      git(world.appDir, 'checkout', '-q', '--detach', world.targetSha);
      const result = deploy(world, ['--env', 'staging', '--ref', world.targetSha, '--force']);
      assert.equal(result.status, 0, result.out);
      assert.equal(head(world), world.targetSha);
      assert.equal(stateOf(world, 'current'), world.targetSha);
      assert.equal(stateOf(world, 'previous'), world.prevSha);
    },
  );

  it('S6: alvo com URL de saúde fora do loopback, APP_DIR com ".." ou APP_DIR raso é recusado', () => {
    const world = makeWorld();
    const confPath = join(world.targetsDir, 'staging.conf');
    const original = readFileSync(confPath, 'utf8');
    writeFileSync(
      confPath,
      original.replace(
        'HEALTH_URL=http://127.0.0.1:39999/health',
        'HEALTH_URL=http://example.org/health',
      ),
    );
    const url = deploy(world, ['--env', 'staging', '--dry-run']);
    assert.equal(url.status, 1);
    assert.match(url.out, /127\.0\.0\.1/);
    writeFileSync(confPath, original.replace('APP_DIR=', 'APP_DIR=/tmp/../'));
    const dots = deploy(world, ['--env', 'staging', '--dry-run']);
    assert.equal(dots.status, 1);
    assert.match(dots.out, /\.\./);
    writeFileSync(
      confPath,
      original
        .replace(/^APP_DIR=.*$/m, 'APP_DIR=/')
        .replace(/^ENV_FILE=.*$/m, 'ENV_FILE=/backend/.env'),
    );
    assert.equal(deploy(world, ['--env', 'staging', '--dry-run']).status, 1);
  });
});

describe('deploy.sh: trava global', { skip: FLOCK_SKIP }, () => {
  it('(g) uma segunda execução simultânea sai com 1', async () => {
    const world = makeWorld();
    setStub(world, 'install_sleep', '4');
    // A primeira execução termina cedo (config:check falha de propósito) depois que a segunda for recusada.
    setStub(world, 'config_fail');
    const first: ChildProcess = spawn(
      'bash',
      [toPosix(SCRIPT), '--env', 'staging', '--ref', world.targetSha],
      {
        cwd: world.appDir,
        env: scriptEnv(world),
        stdio: 'ignore',
      },
    );
    const exited = new Promise<void>((resolve) => {
      first.on('close', () => {
        resolve();
      });
    });
    try {
      const deadline = Date.now() + 20_000;
      while (
        !readIfExists(world.logFile).includes('preparando a versão nova') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        readIfExists(world.logFile).includes('preparando a versão nova'),
        'a primeira execução não chegou ao build',
      );
      const second = deploy(world, ['--env', 'staging', '--ref', world.targetSha]);
      assert.equal(second.status, 1, second.out);
      assert.match(second.out, /outra execução do deploy em andamento/);
    } finally {
      await exited;
    }
  });
});
