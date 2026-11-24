import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';

// Comportamento de deploy/backup/soprei-backup.sh e soprei-restore-check.sh (spec 043): os scripts de
// verdade rodam com `bash`, com dublês de `runuser`, `pg_dump`, `age`, `rclone`, `curl` e dos
// comandos do PostgreSQL no PATH. Nada toca banco, rede nem armazenamento reais; o "destino" é uma
// pasta temporária.
//
// O que depende do sistema é pulado COM AVISO (nunca falha em falso): sem `bash`, o arquivo todo; sem
// `flock` real, só o teste da trava (os demais usam um `flock` de mentira que sempre concede); onde o
// modo de arquivo não é fiel (Windows), a conferência do modo 600 é dispensada pelo gancho de teste
// e o cenário que a prova é pulado. No CI (Ubuntu) nada disso é pulado.

const REPO_ROOT = join(process.cwd(), '..');
const BACKUP_SCRIPT = join(REPO_ROOT, 'deploy', 'backup', 'soprei-backup.sh');
const RESTORE_SCRIPT = join(REPO_ROOT, 'deploy', 'backup', 'soprei-restore-check.sh');

const STORAGE_SENTINEL = 'SENTINELA-CHAVE-DO-ARMAZENAMENTO';
const TOOL_SENTINEL = 'SENTINELA-SAIDA-DE-FERRAMENTA';
const ENV_SENTINEL = 'SENTINELA-SEGREDO-DO-AMBIENTE';
const RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const DAY_MS = 86_400_000;

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

function modesAreFaithful(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'soprei-mode-probe-'));
  try {
    const file = join(dir, 'f');
    writeFileSync(file, 'x');
    chmodSync(file, 0o644);
    const open = spawnSync('bash', ['-c', `stat -c %a "${toPosix(file)}"`], { encoding: 'utf8' });
    chmodSync(file, 0o600);
    const closed = spawnSync('bash', ['-c', `stat -c %a "${toPosix(file)}"`], { encoding: 'utf8' });
    return open.stdout.trim() === '644' && closed.stdout.trim() === '600';
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HAS_BASH = probe('true');
const HAS_REAL_FLOCK = HAS_BASH && probe('command -v flock');
const HAS_MODES = HAS_BASH && modesAreFaithful();
const BASH_SKIP = HAS_BASH ? false : 'bash não encontrado neste ambiente (o CI tem)';
const FLOCK_SKIP = HAS_REAL_FLOCK ? false : 'flock real não encontrado neste ambiente (o CI tem)';
const MODE_SKIP = HAS_MODES
  ? false
  : 'modo de arquivo não é fiel neste ambiente (Windows); o CI (Linux) roda este cenário';

if (!HAS_BASH) console.warn(`[backup-script.behavior] ${String(BASH_SKIP)}`);
else {
  if (!HAS_REAL_FLOCK) console.warn(`[backup-script.behavior] ${String(FLOCK_SKIP)}`);
  if (!HAS_MODES) console.warn(`[backup-script.behavior] ${String(MODE_SKIP)}`);
}

const STUB_RUNUSER = `#!/usr/bin/env bash
echo "runuser $*" >> "$STUB_DIR/events.log"
if [ "\${1:-}" != "-u" ] || [ "\${2:-}" != "postgres" ] || [ "\${3:-}" != "--" ]; then exit 98; fi
shift 3
exec "$@"
`;

const STUB_PG_DUMP = `#!/usr/bin/env bash
echo "pg_dump $*" >> "$STUB_DIR/events.log"
echo "${TOOL_SENTINEL} pg_dump" >&2
if [ -f "$STUB_DIR/pgdump_fail" ]; then printf 'parcial'; exit 1; fi
if [ -f "$STUB_DIR/pgdump_empty" ]; then exit 0; fi
printf 'DUMP %s\\n' "$*"
`;

// Cifra de mentira: prefixa "AGE:". -r REC -o SAIDA ENTRADA | -d -i IDENT -o SAIDA ENTRADA
const STUB_AGE = `#!/usr/bin/env bash
echo "age $*" >> "$STUB_DIR/events.log"
echo "${TOOL_SENTINEL} age" >&2
if [ -f "$STUB_DIR/age_fail" ]; then exit 1; fi
if [ "\${1:-}" = "-d" ]; then
  sed 's/^AGE://' "$6" > "$5"
  exit 0
fi
{ printf 'AGE:'; cat "$5"; } > "$4"
`;

// --config ARQ lsf --files-only --format sp --separator ';' DESTINO/ | --config ARQ copyto ORIGEM DESTINO
const STUB_RCLONE = `#!/usr/bin/env bash
echo "rclone $*" >> "$STUB_DIR/events.log"
# Mostra a configuração (com a credencial) de propósito: o programa não pode repassar esta saída.
cat "$2" >&2
case "\${3:-}" in
  lsf)
    if [ -f "$STUB_DIR/lsf_fail" ]; then exit 1; fi
    for f in "$STUB_DIR/remote"/*; do
      [ -f "$f" ] || continue
      s=$(wc -c < "$f")
      echo "\${s//[[:space:]]/};\${f##*/}"
    done
    exit 0 ;;
  copyto)
    if [ -f "$STUB_DIR/copy_fail" ]; then exit 1; fi
    name=\${5##*/}
    if [ -f "$STUB_DIR/copy_truncate" ]; then printf 'x' > "$STUB_DIR/remote/$name"
    else cp "$4" "$STUB_DIR/remote/$name"; fi
    exit 0 ;;
esac
exit 99
`;

const STUB_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_DIR/events.log"
echo "${TOOL_SENTINEL} curl" >&2
if [ -f "$STUB_DIR/curl_fail" ]; then exit 22; fi
exit 0
`;

const STUB_FLOCK = `#!/usr/bin/env bash
exit 0
`;

// psql -X -At -d BANCO -c SQL
const STUB_PSQL = `#!/usr/bin/env bash
echo "psql $*" >> "$STUB_DIR/events.log"
sql=\${6:-}
case "$sql" in
  *pg_database*)
    if [ -f "$STUB_DIR/db_preexisting" ]; then echo 1; fi
    exit 0 ;;
  *"count(*)"*)
    table=\${sql##* }
    if [ -f "$STUB_DIR/missing_$table" ]; then echo "relation does not exist" >&2; exit 1; fi
    cat "$STUB_DIR/count_$table" 2>/dev/null || echo 3
    exit 0 ;;
esac
exit 97
`;

const STUB_CREATEDB = `#!/usr/bin/env bash
echo "createdb $*" >> "$STUB_DIR/events.log"
if [ -f "$STUB_DIR/createdb_fail" ]; then exit 1; fi
exit 0
`;

const STUB_DROPDB = `#!/usr/bin/env bash
echo "dropdb $*" >> "$STUB_DIR/events.log"
exit 0
`;

const STUB_PG_RESTORE = `#!/usr/bin/env bash
echo "pg_restore $*" >> "$STUB_DIR/events.log"
cat > "$STUB_DIR/restored_input"
if [ -f "$STUB_DIR/restore_fail" ]; then echo "conteudo ${TOOL_SENTINEL}" >&2; exit 1; fi
exit 0
`;

interface World {
  root: string;
  stubDir: string;
  remoteDir: string;
  localDir: string;
  statusFile: string;
  confFile: string;
  rcloneConf: string;
  lockFile: string;
  tmpDir: string;
}

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(path, mode);
}

function confText(world: World, overrides: Record<string, string | null> = {}): string {
  const values: Record<string, string | null> = {
    DB_NAME: 'soprei',
    LOCAL_DIR: toPosix(world.localDir),
    LOCAL_KEEP_DAYS: '7',
    AGE_RECIPIENT: RECIPIENT,
    REMOTE: 'r2:soprei-backup/postgres',
    RCLONE_CONFIG_FILE: toPosix(world.rcloneConf),
    STATUS_FILE: toPosix(world.statusFile),
    ...overrides,
  };
  const lines = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`);
  return ['# configuração de teste', '', ...lines, ''].join('\n');
}

function makeWorld(overrides: Record<string, string | null> = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'soprei-backup-'));
  roots.push(root);
  const world: World = {
    root,
    stubDir: join(root, 'stub'),
    remoteDir: join(root, 'stub', 'remote'),
    localDir: join(root, 'var', 'backups', 'soprei'),
    statusFile: join(root, 'state', 'soprei-backup', 'status'),
    confFile: join(root, 'etc', 'backup.conf'),
    rcloneConf: join(root, 'etc', 'rclone.conf'),
    lockFile: join(root, 'backup.lock'),
    tmpDir: join(root, 'tmp'),
  };
  for (const dir of [world.stubDir, world.remoteDir, world.tmpDir])
    mkdirSync(dir, { recursive: true });
  write(world.confFile, confText(world, overrides), 0o600);
  write(world.rcloneConf, `[r2]\ntype = s3\nsecret_access_key = ${STORAGE_SENTINEL}\n`, 0o600);
  const stubs: Record<string, string> = {
    runuser: STUB_RUNUSER,
    pg_dump: STUB_PG_DUMP,
    age: STUB_AGE,
    rclone: STUB_RCLONE,
    curl: STUB_CURL,
    psql: STUB_PSQL,
    createdb: STUB_CREATEDB,
    dropdb: STUB_DROPDB,
    pg_restore: STUB_PG_RESTORE,
  };
  for (const [name, body] of Object.entries(stubs)) write(join(world.stubDir, name), body, 0o755);
  if (!HAS_REAL_FLOCK) write(join(world.stubDir, 'flock'), STUB_FLOCK, 0o755);
  return world;
}

function scriptEnv(world: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const basePath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_OPTIONS'];
  delete env['Path'];
  env['PATH'] = `${world.stubDir}${delimiter}${basePath}`;
  env['SOPREI_BACKUP_CONF'] = toPosix(world.confFile);
  env['SOPREI_BACKUP_LOCK_FILE'] = toPosix(world.lockFile);
  env['SOPREI_BACKUP_RUNUSER'] = toPosix(join(world.stubDir, 'runuser'));
  env['STUB_DIR'] = toPosix(world.stubDir);
  env['TMPDIR'] = toPosix(world.tmpDir);
  env['SEGREDO_QUALQUER'] = ENV_SENTINEL;
  if (!HAS_MODES) env['SOPREI_BACKUP_TEST_NO_MODE_CHECK'] = '1';
  return env;
}

interface RunResult {
  status: number | null;
  out: string;
  events: string[];
  statusText: string;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function eventsOf(world: World): string[] {
  return readIfExists(join(world.stubDir, 'events.log'))
    .split('\n')
    .filter((line) => line !== '');
}

function run(
  script: string,
  world: World,
  args: string[],
  extra: Record<string, string> = {},
): RunResult {
  const result = spawnSync('bash', [toPosix(script), ...args], {
    cwd: world.root,
    env: scriptEnv(world, extra),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    events: eventsOf(world),
    statusText: readIfExists(world.statusFile),
  };
}

const backup = (world: World, args: string[] = [], extra: Record<string, string> = {}): RunResult =>
  run(BACKUP_SCRIPT, world, args, extra);

function setStub(world: World, name: string, content = '1'): void {
  writeFileSync(join(world.stubDir, name), content);
}

function clearStub(world: World, name: string): void {
  rmSync(join(world.stubDir, name), { force: true });
}

function localFiles(world: World): string[] {
  return existsSync(world.localDir) ? readdirSync(world.localDir).sort() : [];
}

function remoteFiles(world: World): string[] {
  return readdirSync(world.remoteDir).sort();
}

/** Cria um arquivo na pasta local com a data de modificação `days` dias atrás. */
function seedLocal(world: World, name: string, days: number, content = 'antigo'): string {
  const path = join(world.localDir, name);
  write(path, content);
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(path, when, when);
  return path;
}

function statusField(result: RunResult, field: string): string | undefined {
  return new RegExp(`^${field}=(.*)$`, 'm').exec(result.statusText)?.[1];
}

function commands(result: RunResult, tool: string): string[] {
  return result.events.filter((line) => line.startsWith(`${tool} `));
}

function waitNextSecond(): void {
  spawnSync('bash', ['-c', 'sleep 1.2']);
}

describe('soprei-backup.sh (spec 043)', { skip: BASH_SKIP }, () => {
  it('execução normal: dump, cifra, envia só o arquivo cifrado, confere e grava o estado', () => {
    const world = makeWorld();
    const result = backup(world);
    assert.equal(result.status, 0, result.out);

    const remote = remoteFiles(world);
    assert.equal(remote.length, 1);
    assert.match(remote[0] ?? '', /^soprei-\d{8}T\d{6}Z\.dump\.age$/);
    assert.equal(
      readFileSync(join(world.remoteDir, remote[0] ?? ''), 'utf8'),
      'AGE:DUMP -Fc soprei\n',
    );
    const stamp = (remote[0] ?? '').replace('.dump.age', '');
    assert.deepEqual(localFiles(world), [`${stamp}.dump`, `${stamp}.dump.age`]);

    const tools = result.events.map(
      (line) => `${line.split(' ')[0] ?? ''} ${line.split(' ')[3] ?? ''}`,
    );
    assert.deepEqual(
      tools.map((line) => line.split(' ')[0]),
      ['runuser', 'pg_dump', 'age', 'rclone', 'rclone', 'rclone'],
    );
    assert.deepEqual(
      commands(result, 'rclone').map((line) => line.split(' ')[3]),
      ['lsf', 'copyto', 'lsf'],
    );
    assert.equal(commands(result, 'runuser')[0], 'runuser -u postgres -- pg_dump -Fc soprei');
    assert.match(commands(result, 'age')[0] ?? '', new RegExp(`^age -r ${RECIPIENT} -o `));

    assert.equal(statusField(result, 'result'), 'ok');
    assert.equal(statusField(result, 'step'), 'concluido');
    assert.equal(statusField(result, 'file'), remote[0]);
    assert.equal(
      statusField(result, 'size_bytes'),
      String(statSync(join(world.remoteDir, remote[0] ?? '')).size),
    );
    assert.equal(statusField(result, 'ping'), 'none');

    // A listagem vai exatamente como o programa a interpreta (tamanho;nome, só arquivos).
    const listing = commands(result, 'rclone').filter((line) => line.split(' ')[3] === 'lsf');
    for (const line of listing) {
      assert.equal(
        line,
        `rclone --config ${toPosix(world.rcloneConf)} lsf --files-only --format sp --separator ; r2:soprei-backup/postgres/`,
      );
    }
    // A saída das ferramentas (inclusive a configuração que o dublê do rclone imprime) fica no
    // registro privado, e só lá.
    const runLog = readFileSync(join(world.statusFile, '..', 'last-run.log'), 'utf8');
    assert.ok(runLog.includes(TOOL_SENTINEL));
    assert.ok(runLog.includes(STORAGE_SENTINEL));
    if (HAS_MODES) {
      const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
      assert.equal(mode(world.localDir), '700');
      assert.equal(mode(join(world.statusFile, '..')), '700');
      assert.equal(mode(world.statusFile), '600');
      assert.equal(mode(join(world.statusFile, '..', 'last-run.log')), '600');
      for (const name of localFiles(world)) assert.equal(mode(join(world.localDir, name)), '600');
    }
    assert.equal(commands(result, 'curl').length, 0, 'sem PING_URL não há aviso');
  });

  it('o envio nunca recebe um arquivo não cifrado, nem com sobras claras na pasta', () => {
    const world = makeWorld();
    seedLocal(world, 'soprei-20200101T000000Z.dump', 1, 'claro');
    seedLocal(world, 'notas.txt', 1);
    const result = backup(world);
    assert.equal(result.status, 0, result.out);
    const sent = commands(result, 'rclone').filter((line) => line.split(' ')[3] === 'copyto');
    assert.ok(sent.length >= 1);
    for (const line of sent) {
      const [, , , , source, destination] = line.split(' ');
      assert.match(source ?? '', /\.dump\.age$/, line);
      assert.match(destination ?? '', /^r2:soprei-backup\/postgres\/soprei-.*\.dump\.age$/, line);
    }
    for (const name of remoteFiles(world)) assert.match(name, /\.dump\.age$/);
    for (const line of commands(result, 'rclone')) {
      assert.doesNotMatch(line, / (delete|deletefile|purge|rmdir|rmdirs|sync|move|moveto) /);
    }
  });

  it('pg_dump que falha: sai com 2, não cifra, não envia, não apaga nada antigo e não avisa', () => {
    const world = makeWorld({ PING_URL: 'https://sinal.exemplo.invalid/ping/abc' });
    const old = seedLocal(world, 'soprei-20200101T000000Z.dump', 30);
    setStub(world, 'pgdump_fail');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(commands(result, 'age').length, 0);
    assert.equal(commands(result, 'rclone').length, 0);
    assert.equal(commands(result, 'curl').length, 0);
    assert.ok(existsSync(old), 'a cópia antiga continua lá');
    assert.deepEqual(
      localFiles(world).filter((name) => name.endsWith('.tmp')),
      [],
    );
    assert.deepEqual(remoteFiles(world), []);
    assert.equal(statusField(result, 'result'), 'failed');
    assert.equal(statusField(result, 'step'), 'dump');
  });

  it('cifra que falha: sai com 2 e nada é enviado', () => {
    const world = makeWorld();
    setStub(world, 'age_fail');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(commands(result, 'rclone').length, 0);
    assert.equal(statusField(result, 'step'), 'cifrar');
    assert.deepEqual(
      localFiles(world).filter((name) => name.endsWith('.age') || name.endsWith('.tmp')),
      [],
    );
  });

  it('envio que falha: sai com 2, o arquivo cifrado fica e nada antigo é apagado', () => {
    const world = makeWorld({ PING_URL: 'https://sinal.exemplo.invalid/ping/abc' });
    const old = seedLocal(world, 'soprei-20200101T000000Z.dump', 30);
    setStub(world, 'copy_fail');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(statusField(result, 'result'), 'failed');
    assert.equal(statusField(result, 'step'), 'enviar');
    assert.ok(existsSync(old));
    assert.equal(localFiles(world).filter((name) => name.endsWith('.dump.age')).length, 1);
    assert.equal(commands(result, 'curl').length, 0);
  });

  it('tamanho diferente no destino: sai com 2 no passo de conferência', () => {
    const world = makeWorld();
    const old = seedLocal(world, 'soprei-20200101T000000Z.dump', 30);
    setStub(world, 'copy_truncate');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(statusField(result, 'step'), 'conferir');
    assert.ok(existsSync(old), 'a cópia antiga continua lá');
    assert.equal(localFiles(world).filter((name) => name.endsWith('.dump.age')).length, 1);
  });

  it('nome igual com outro tamanho no destino: envia os demais e falha no fim, sem apagar nada', () => {
    const world = makeWorld();
    const stuck = seedLocal(world, 'soprei-20200101T000000Z.dump.age', 30, 'AGE:inteiro');
    writeFileSync(join(world.remoteDir, 'soprei-20200101T000000Z.dump.age'), 'AGE:int');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(statusField(result, 'step'), 'conferir');
    assert.equal(remoteFiles(world).length, 2, 'o backup de hoje foi enviado mesmo assim');
    assert.equal(
      readFileSync(join(world.remoteDir, 'soprei-20200101T000000Z.dump.age'), 'utf8'),
      'AGE:int',
    );
    assert.ok(existsSync(stuck), 'nada antigo é apagado numa execução que falha');
  });

  it('pg_dump que termina bem com saída vazia: sai com 2 no passo do dump', () => {
    const world = makeWorld();
    setStub(world, 'pgdump_empty');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(statusField(result, 'step'), 'dump');
    assert.equal(commands(result, 'age').length, 0);
    assert.deepEqual(localFiles(world), []);
  });

  it('falha inesperada depois da trava: sai com 2 e grava o estado, nunca deixa o ok antigo', () => {
    const world = makeWorld();
    // Um arquivo no lugar da pasta pai: o mkdir da preparação falha fora de qualquer `|| fail`.
    write(join(world.root, 'var', 'backups'), 'não é pasta');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(statusField(result, 'result'), 'failed');
    assert.equal(statusField(result, 'step'), 'preparar');
    assert.deepEqual(result.events, []);
  });

  it('listagem do destino que falha: sai com 2 sem enviar', () => {
    const world = makeWorld();
    setStub(world, 'lsf_fail');
    const result = backup(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(statusField(result, 'step'), 'listar');
    assert.equal(
      commands(result, 'rclone').filter((line) => line.split(' ')[3] === 'copyto').length,
      0,
    );
  });

  it('depois de uma falha de envio, a execução seguinte envia o pendente junto com o novo', () => {
    const world = makeWorld();
    setStub(world, 'copy_fail');
    assert.equal(backup(world).status, 2);
    assert.deepEqual(remoteFiles(world), []);
    clearStub(world, 'copy_fail');
    waitNextSecond();
    const second = backup(world);
    assert.equal(second.status, 0, second.out);
    assert.equal(remoteFiles(world).length, 2);
    assert.deepEqual(
      remoteFiles(world),
      localFiles(world).filter((name) => name.endsWith('.dump.age')),
    );
    // Nada que já está no destino é enviado de novo (o destino recusa sobrescrita).
    waitNextSecond();
    const before = eventsOf(world).length;
    const third = backup(world);
    assert.equal(third.status, 0, third.out);
    const sent = third.events
      .slice(before)
      .filter((line) => line.startsWith('rclone ') && line.split(' ')[3] === 'copyto');
    assert.equal(sent.length, 1);
  });

  it('expiração local: só arquivos do backup com mais de LOCAL_KEEP_DAYS dias somem', () => {
    const world = makeWorld();
    const oldDump = seedLocal(world, 'soprei-20200101T000000Z.dump', 30);
    const oldAge = seedLocal(world, 'soprei-20200101T000000Z.dump.age', 30);
    const recent = seedLocal(world, 'soprei-20991231T000000Z.dump', 2);
    const stranger = seedLocal(world, 'outro.dump', 30);
    const notes = seedLocal(world, 'soprei-notas.txt', 30);
    const outside = join(world.root, 'var', 'backups', 'soprei-20200101T000000Z.dump');
    write(outside, 'fora');
    const longAgo = new Date(Date.now() - 30 * DAY_MS);
    utimesSync(outside, longAgo, longAgo);

    const result = backup(world);
    assert.equal(result.status, 0, result.out);
    assert.ok(!existsSync(oldDump), 'dump antigo apagado');
    assert.ok(!existsSync(oldAge), 'cifrado antigo apagado (depois de enviado)');
    assert.ok(existsSync(recent), 'cópia recente fica');
    assert.ok(existsSync(stranger), 'arquivo fora do padrão de nome fica');
    assert.ok(existsSync(notes), 'arquivo fora do padrão de nome fica');
    assert.ok(existsSync(outside), 'nada fora de LOCAL_DIR é tocado');
    assert.ok(remoteFiles(world).includes('soprei-20200101T000000Z.dump.age'));
  });

  it(
    'duas execuções ao mesmo tempo: a segunda sai com 3 sem fazer nada',
    { skip: FLOCK_SKIP },
    async () => {
      const world = makeWorld();
      const holder = spawn(
        'bash',
        ['-c', `exec 9>"${toPosix(world.lockFile)}"; flock 9; echo pronto; exec sleep 30`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          holder.stdout.once('data', () => {
            resolve();
          });
          holder.once('error', reject);
        });
        const result = backup(world);
        assert.equal(result.status, 3, result.out);
        assert.deepEqual(result.events, []);
        assert.deepEqual(localFiles(world), []);
        assert.equal(result.statusText, '');
      } finally {
        holder.kill();
      }
    },
  );

  it('--dry-run só lista o destino: não gera, não envia, não apaga e não cria arquivo', () => {
    const world = makeWorld({ PING_URL: 'https://sinal.exemplo.invalid/ping/abc' });
    const old = seedLocal(world, 'soprei-20200101T000000Z.dump', 30);
    const before = localFiles(world);
    const result = backup(world, ['--dry-run']);
    assert.equal(result.status, 0, result.out);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.split(' ')[3], 'lsf');
    assert.deepEqual(localFiles(world), before);
    assert.ok(existsSync(old));
    assert.ok(!existsSync(world.statusFile), 'sem arquivo de estado');
    assert.ok(!existsSync(world.lockFile), 'sem arquivo de trava');
    assert.ok(!existsSync(join(world.root, 'state')), 'sem pasta de estado');
    assert.deepEqual(remoteFiles(world), []);
  });

  it('configuração inválida: sai com 1 antes de qualquer passo', () => {
    const cases: [string, Record<string, string | null>][] = [
      ['chave desconhecida', { OUTRA_CHAVE: 'x' }],
      ['AGE_RECIPIENT que não é chave pública do age', { AGE_RECIPIENT: 'ssh-ed25519' }],
      ['AGE_RECIPIENT ausente', { AGE_RECIPIENT: null }],
      ['REMOTE sem bucket', { REMOTE: 'r2' }],
      ['REMOTE com ..', { REMOTE: 'r2:bucket/../outro' }],
      ['REMOTE começando com hífen', { REMOTE: '-x:bucket/pasta' }],
      ['bucket começando com hífen', { REMOTE: 'r2:-bucket/pasta' }],
      ['REMOTE ausente', { REMOTE: null }],
      ['valor com substituição de comando', { DB_NAME: '$(id)' }],
      ['DB_NAME com hífen inicial', { DB_NAME: '-x' }],
      ['LOCAL_KEEP_DAYS zero', { LOCAL_KEEP_DAYS: '0' }],
      ['LOCAL_KEEP_DAYS acima de 35', { LOCAL_KEEP_DAYS: '36' }],
      ['LOCAL_DIR sem soprei no nome', { LOCAL_DIR: '/var/backups/outra' }],
      ['STATUS_FILE direto numa pasta do sistema', { STATUS_FILE: '/var/lib/status' }],
      ['STATUS_FILE em pasta sem soprei no nome', { STATUS_FILE: '/var/lib/outra/status' }],
      ['LOCAL_DIR relativo', { LOCAL_DIR: 'backups/soprei' }],
      ['LOCAL_DIR raso', { LOCAL_DIR: '/backups' }],
      ['PING_URL sem https', { PING_URL: 'http://sinal.exemplo.invalid/x' }],
      ['PING_URL com query', { PING_URL: 'https://sinal.exemplo.invalid/x?a=b' }],
    ];
    for (const [label, overrides] of cases) {
      const world = makeWorld(overrides);
      const result = backup(world);
      assert.equal(result.status, 1, `${label}: ${result.out}`);
      assert.deepEqual(result.events, [], label);
      assert.deepEqual(localFiles(world), [], label);
      assert.equal(result.statusText, '', label);
    }
    const missing = makeWorld();
    rmSync(missing.confFile);
    assert.equal(backup(missing).status, 1);
    const noRclone = makeWorld();
    rmSync(noRclone.rcloneConf);
    const result = backup(noRclone);
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(result.events, []);
    const badArg = makeWorld();
    assert.equal(backup(badArg, ['--force']).status, 1);
    assert.deepEqual(eventsOf(badArg), []);
  });

  it(
    'configuração ou credencial com modo mais aberto que 600 é recusada',
    { skip: MODE_SKIP },
    () => {
      const openConf = makeWorld();
      chmodSync(openConf.confFile, 0o644);
      const first = backup(openConf);
      assert.equal(first.status, 1, first.out);
      assert.deepEqual(first.events, []);

      const openCredential = makeWorld();
      chmodSync(openCredential.rcloneConf, 0o640);
      const second = backup(openCredential);
      assert.equal(second.status, 1, second.out);
      assert.deepEqual(second.events, []);
    },
  );

  it('nenhum segredo nem saída de ferramenta aparece na saída do programa ou no estado', () => {
    for (const failing of [null, 'pgdump_fail', 'age_fail', 'copy_fail', 'lsf_fail', 'curl_fail']) {
      const world = makeWorld({ PING_URL: 'https://sinal.exemplo.invalid/ping/abc' });
      if (failing !== null) setStub(world, failing);
      const result = backup(world);
      for (const sentinel of [STORAGE_SENTINEL, TOOL_SENTINEL, ENV_SENTINEL, RECIPIENT]) {
        assert.ok(!result.out.includes(sentinel), `${String(failing)}: ${sentinel} na saída`);
        assert.ok(
          !result.statusText.includes(sentinel),
          `${String(failing)}: ${sentinel} no estado`,
        );
      }
      for (const line of result.events) {
        assert.ok(!line.includes(STORAGE_SENTINEL), 'credencial nunca vai em argumento');
        assert.ok(!line.includes(ENV_SENTINEL));
      }
    }
  });

  it('o sinal de vida é um único GET, só com sucesso, sem corpo e sem parâmetro acrescentado', () => {
    const url = 'https://sinal.exemplo.invalid/ping/abc-123';
    const world = makeWorld({ PING_URL: url });
    const result = backup(world);
    assert.equal(result.status, 0, result.out);
    const calls = commands(result, 'curl');
    assert.equal(calls.length, 1);
    const args = (calls[0] ?? '').split(' ').slice(1);
    assert.equal(args.at(-1), url, 'a URL vai exatamente como configurada');
    assert.ok(!args.some((arg) => arg.startsWith('--retry')), 'um único pedido');
    assert.equal(args[0], '-q', 'sem o .curlrc do root');
    assert.equal(args.filter((arg) => arg.startsWith('http')).length, 1);
    for (const arg of args) {
      assert.doesNotMatch(
        arg,
        /^(-d|--data.*|-F|--form.*|-X|--request|-T|--upload-file|-H|--header)$/,
      );
    }
    assert.equal(statusField(result, 'ping'), 'ok');
  });

  it('sinal de vida que falha não desfaz o backup: sai com 0 e registra ping=failed', () => {
    const world = makeWorld({ PING_URL: 'https://sinal.exemplo.invalid/ping/abc' });
    setStub(world, 'curl_fail');
    const result = backup(world);
    assert.equal(result.status, 0, result.out);
    assert.equal(statusField(result, 'result'), 'ok');
    assert.equal(statusField(result, 'ping'), 'failed');
    assert.equal(remoteFiles(world).length, 1);
  });
});

describe('soprei-restore-check.sh (spec 043)', { skip: BASH_SKIP }, () => {
  const CHECK_DB = 'soprei_restore_check';

  function makeRestoreWorld(): World & { encrypted: string; identity: string } {
    const world = makeWorld();
    const encrypted = join(world.root, 'baixado', 'soprei-20261123T063000Z.dump.age');
    write(encrypted, 'AGE:CONTEUDO-DO-DUMP');
    const identity = join(world.root, 'chave', 'identidade.txt');
    write(identity, 'AGE-SECRET-KEY-1DEMENTIRA');
    return { ...world, encrypted, identity };
  }

  const restore = (
    world: World & { encrypted: string; identity: string },
    args?: string[],
  ): RunResult =>
    run(RESTORE_SCRIPT, world, args ?? [toPosix(world.encrypted), toPosix(world.identity)]);

  function databaseNames(result: RunResult): string[] {
    const names: string[] = [];
    for (const line of result.events) {
      const parts = line.split(' ');
      if (parts[0] === 'createdb') names.push(parts.at(-1) ?? '');
      if (parts[0] === 'dropdb') names.push(parts.at(-1) ?? '');
      if (parts[0] === 'pg_restore') names.push(parts[parts.indexOf('-d') + 1] ?? '');
    }
    return names;
  }

  it('restaura no banco temporário, imprime só contagens e apaga banco e arquivo decifrado', () => {
    const world = makeRestoreWorld();
    setStub(world, 'count_messages', '42');
    const result = restore(world);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /tabela companies: 3 linha\(s\)/);
    assert.match(result.out, /tabela messages: 42 linha\(s\)/);
    assert.ok(!result.out.includes('CONTEUDO-DO-DUMP'), 'o conteúdo nunca é impresso');
    assert.equal(readIfExists(join(world.stubDir, 'restored_input')), 'CONTEUDO-DO-DUMP');
    assert.ok(result.events.includes(`createdb ${CHECK_DB}`));
    assert.equal(result.events.at(-1), `dropdb --if-exists ${CHECK_DB}`);
    assert.ok(databaseNames(result).length >= 3);
    for (const name of databaseNames(result)) assert.equal(name, CHECK_DB);
    assert.deepEqual(readdirSync(world.tmpDir), [], 'a pasta de trabalho foi apagada');
    for (const line of commands(result, 'runuser')) assert.match(line, /^runuser -u postgres -- /);
  });

  it('recusa rodar se o banco temporário já existe, sem criar nem apagar nada', () => {
    const world = makeRestoreWorld();
    setStub(world, 'db_preexisting');
    const result = restore(world);
    assert.equal(result.status, 1, result.out);
    assert.equal(commands(result, 'createdb').length, 0);
    assert.equal(commands(result, 'dropdb').length, 0);
    assert.equal(commands(result, 'age').length, 0);
    assert.deepEqual(readdirSync(world.tmpDir), []);
  });

  it('restauração que falha: sai com 2 e mesmo assim apaga o banco e o arquivo decifrado', () => {
    const world = makeRestoreWorld();
    setStub(world, 'restore_fail');
    const result = restore(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(result.events.at(-1), `dropdb --if-exists ${CHECK_DB}`);
    assert.deepEqual(readdirSync(world.tmpDir), []);
    assert.ok(!result.out.includes(TOOL_SENTINEL), 'a saída do pg_restore não é repassada');
  });

  it('chave errada (o age falha): sai com 2 sem criar banco e apaga a pasta de trabalho', () => {
    const world = makeRestoreWorld();
    setStub(world, 'age_fail');
    const result = restore(world);
    assert.equal(result.status, 2, result.out);
    assert.equal(commands(result, 'createdb').length, 0);
    assert.equal(commands(result, 'dropdb').length, 0);
    assert.deepEqual(readdirSync(world.tmpDir), []);
  });

  it('tabela principal vazia ou ausente: sai com 2 e apaga o banco', () => {
    const empty = makeRestoreWorld();
    setStub(empty, 'count_companies', '0');
    const first = restore(empty);
    assert.equal(first.status, 2, first.out);
    assert.equal(first.events.at(-1), `dropdb --if-exists ${CHECK_DB}`);

    const missing = makeRestoreWorld();
    setStub(missing, 'missing_messages');
    const second = restore(missing);
    assert.equal(second.status, 2, second.out);
    assert.equal(second.events.at(-1), `dropdb --if-exists ${CHECK_DB}`);
  });

  it('argumentos inválidos: sai com 1 sem tocar em nada', () => {
    const world = makeRestoreWorld();
    const plain = join(world.root, 'baixado', 'soprei.dump');
    write(plain, 'claro');
    const cases: string[][] = [
      [],
      [toPosix(world.encrypted)],
      [toPosix(plain), toPosix(world.identity)],
      [toPosix(world.encrypted), toPosix(join(world.root, 'nao-existe'))],
      ['--banco', 'soprei', toPosix(world.encrypted), toPosix(world.identity)],
      [toPosix(world.encrypted), toPosix(world.identity), 'soprei'],
    ];
    for (const args of cases) {
      const result = restore(world, args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.out}`);
      assert.deepEqual(result.events, []);
    }
  });

  it('--as-current-user roda os comandos do PostgreSQL sem runuser, no mesmo banco fixo', () => {
    const world = makeRestoreWorld();
    const result = restore(world, [
      '--as-current-user',
      toPosix(world.encrypted),
      toPosix(world.identity),
    ]);
    assert.equal(result.status, 0, result.out);
    assert.equal(commands(result, 'runuser').length, 0);
    for (const name of databaseNames(result)) assert.equal(name, CHECK_DB);
    assert.equal(result.events.at(-1), `dropdb --if-exists ${CHECK_DB}`);
  });
});
