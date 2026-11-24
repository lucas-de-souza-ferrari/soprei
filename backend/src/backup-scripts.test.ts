import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Gate de texto da spec 043: lê os arquivos de `deploy/backup/` como texto, no modelo de
// `deploy-scripts.test.ts`, e falha se uma mudança futura enfraquecer o que o backup promete (nada de
// `source`, de rastreamento do shell, de apagar no destino; saída das ferramentas só no registro
// privado; exemplos sem segredo). O comportamento é provado em `backup-script.behavior.test.ts`.
const REPO_ROOT = join(process.cwd(), '..');
const read = (path: string): string =>
  readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n');

const SCRIPTS = ['deploy/backup/soprei-backup.sh', 'deploy/backup/soprei-restore-check.sh'];
const EXAMPLES = [
  'deploy/backup/backup.conf.example',
  'deploy/backup/rclone.conf.example',
  'deploy/backup/soprei-backup.service.example',
  'deploy/backup/soprei-backup.timer.example',
];

/** Linhas de código: sem comentários de linha inteira nem linhas em branco. */
function codeLinesOf(path: string): string[] {
  return read(path)
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
}

describe('scripts de backup (spec 043)', () => {
  it('opções do shell, umask 077 e nenhum rastreamento, source ou eval', () => {
    for (const path of SCRIPTS) {
      const code = codeLinesOf(path).join('\n');
      assert.match(code, /^set -Eeuo pipefail$/m, path);
      assert.match(code, /^umask 077$/m, path);
      assert.match(code, /^export LC_ALL=C$/m, path);
      assert.doesNotMatch(code, /\bset\s+-[A-Za-z]*x/, path);
      assert.doesNotMatch(code, /\bbash\s+-[A-Za-z]*x/, path);
      assert.doesNotMatch(code, /^\s*(source|\.)\s+\S/m, path);
      assert.doesNotMatch(code, /\beval\b/, path);
    }
  });

  it('toda a lógica está em funções e `main "$@"` é a última linha', () => {
    for (const path of SCRIPTS) {
      const lines = read(path).split('\n');
      assert.equal(lines.filter((line) => line.trim() !== '').at(-1), 'main "$@"', path);
      const topLevel = lines.filter((line) => /^\S/.test(line) && !line.startsWith('#'));
      for (const line of topLevel) {
        assert.match(
          line,
          /^([A-Za-z_][A-Za-z0-9_]*=|readonly |export |set |umask |IFS=|[a-z_0-9]+\(\) \{$|\}$|main "\$@"$)/,
          `${path}: comando solto fora de função: ${line}`,
        );
      }
    }
  });

  it('são executáveis no índice do Git (o dono instala por cópia)', () => {
    const listed = execFileSync('git', ['ls-files', '-s', '--', ...SCRIPTS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const modes = listed
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split(' ')[0]);
    assert.deepEqual(modes, ['100755', '100755']);
  });

  it('o backup nunca apaga, move nem sincroniza no destino e só usa lsf e copyto', () => {
    const lines = codeLinesOf('deploy/backup/soprei-backup.sh');
    // Toda chamada ao rclone passa a configuração explícita; a outra menção é a conferência do PATH.
    const calls = lines.filter((line) => /\brclone /.test(line) && !/for tool in/.test(line));
    assert.equal(calls.length, 2);
    for (const line of calls) {
      assert.match(line, /rclone --config "\$RCLONE_CONFIG_FILE" (lsf|copyto) /, line);
      assert.doesNotMatch(line, /\b(delete|deletefile|purge|rmdirs?|sync|move|moveto|cleanup)\b/);
    }
    // O único apagamento do programa é local, por `find` dentro de LOCAL_DIR.
    const deletions = lines.filter((line) => /-delete\b|\brm\b/.test(line));
    for (const line of deletions) {
      assert.match(
        line,
        /find "\$LOCAL_DIR" -maxdepth 1|-mmin "\+\$\(\(LOCAL_KEEP_DAYS \* 1440\)\)" -delete|rm -f "\$tmp"/,
      );
    }
  });

  it('a saída de pg_dump, age, rclone e curl vai só para o registro privado da execução', () => {
    const lines = codeLinesOf('deploy/backup/soprei-backup.sh');
    const invocations = lines.filter((line) =>
      /("\$RUNUSER" -u postgres|^\s*age -r|rclone --config|curl -q -fsS)/.test(line),
    );
    assert.equal(invocations.length, 5);
    for (const line of invocations) {
      const next = lines[lines.indexOf(line) + 1] ?? '';
      assert.match(`${line}\n${next}`.split('||')[0] ?? '', /2?>>"\$RUN_LOG"/, line);
    }
    // O dump é a única saída padrão aproveitada, e vai para o arquivo temporário.
    assert.match(lines.join('\n'), /pg_dump -Fc "\$DB_NAME" >"\$tmp" 2>>"\$RUN_LOG"/);
    // A configuração do rclone (com a credencial) nunca é lida nem impressa pelo programa.
    for (const line of lines) {
      if (/\b(cat|echo|printf|tee|grep|sed|awk|head|tail)\b/.test(line)) {
        assert.doesNotMatch(line, /RCLONE_CONFIG_FILE|CONF_FILE|AGE_RECIPIENT/, line);
      }
    }
  });

  it('o envio só aceita .dump.age e o pg_dump roda como postgres, sem senha em argumento', () => {
    const code = codeLinesOf('deploy/backup/soprei-backup.sh').join('\n');
    assert.match(code, /for file in "\$LOCAL_DIR"\/soprei-\*\.dump\.age; do/);
    assert.match(code, /case "\$name" in \*\.dump\.age\) ;; \*\) fail /);
    assert.match(code, /"\$RUNUSER" -u postgres -- pg_dump -Fc "\$DB_NAME"/);
    assert.doesNotMatch(code, /PGPASSWORD|--password|postgres(ql)?:\/\//);
  });

  it('o sinal de vida é um GET sem corpo, sem cabeçalho e sem parâmetro acrescentado', () => {
    const lines = codeLinesOf('deploy/backup/soprei-backup.sh').filter((line) =>
      /\bcurl\b/.test(line),
    );
    const calls = lines.filter((line) => /curl -/.test(line));
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /curl -q -fsS -m 10 -o \/dev\/null "\$PING_URL" /);
  });

  it('o teste de restauração só usa o banco de nome fixo e sempre limpa ao sair', () => {
    const code = codeLinesOf('deploy/backup/soprei-restore-check.sh').join('\n');
    assert.match(code, /^readonly CHECK_DB=soprei_restore_check$/m);
    assert.match(code, /trap cleanup EXIT/);
    assert.match(code, /pg dropdb --if-exists "\$CHECK_DB"/);
    assert.match(code, /rm -rf "\$WORK_DIR"/);
    for (const line of code.split('\n')) {
      if (/\b(createdb|dropdb|pg_restore)\b/.test(line) && !/^\s*(log|#)/.test(line)) {
        assert.doesNotMatch(line, /soprei(?!_restore_check)\b[^-]/, line);
      }
      if (/-d /.test(line) && /psql|pg_restore/.test(line)) {
        assert.match(line, /-d ("\$CHECK_DB"|postgres) /, line);
      }
    }
    // Só contagens saem: nenhuma consulta que devolva conteúdo.
    const queries = code.split('\n').filter((line) => /-c "/.test(line));
    assert.equal(queries.length, 2);
    assert.match(queries.join('\n'), /SELECT 1 FROM pg_database/);
    assert.match(queries.join('\n'), /SELECT count\(\*\) FROM \$table/);
  });
});

describe('robustez do backup (revisão da spec 043)', () => {
  const code = codeLinesOf('deploy/backup/soprei-backup.sh').join('\n');

  it('a trava padrão fica em /run, onde só o root escreve', () => {
    assert.match(code, /^LOCK_FILE=\$\{SOPREI_BACKUP_LOCK_FILE:-\/run\/soprei-backup\.lock\}$/m);
    assert.doesNotMatch(code, /\/var\/lock/);
  });

  it('depois da trava, uma falha inesperada passa por fail (estado gravado, saída 2)', () => {
    const main = code.slice(code.indexOf('\nmain() {'));
    const lock = main.indexOf('acquire_lock');
    const trap = main.indexOf(`trap 'fail "erro inesperado na linha $LINENO"' ERR`);
    const prepare = main.indexOf('prepare_dirs');
    assert.ok(
      lock >= 0 && trap > lock && prepare > trap,
      'trava, depois o trap, depois o trabalho',
    );
    assert.match(code, /^fail\(\) \{\n {2}trap - ERR$/m);
  });

  it('pastas e registro do backup ficam fechados mesmo se já existiam', () => {
    assert.match(code, /chmod 700 "\$LOCAL_DIR" "\$\{STATUS_FILE%\/\*\}"/);
    assert.match(code, /chmod 600 "\$RUN_LOG"/);
  });

  it('o teste de restauração tem a exceção do shellcheck na função chamada só pelo trap', () => {
    const lines = read('deploy/backup/soprei-restore-check.sh').split('\n');
    const at = lines.indexOf('cleanup() {');
    assert.ok(at > 0);
    assert.equal(lines[at - 1], '# shellcheck disable=SC2329');
  });
});

describe('exemplos de deploy/backup (spec 043)', () => {
  it('a configuração de exemplo só tem as chaves que o programa conhece e nenhum segredo', () => {
    const known = [
      ...read('deploy/backup/soprei-backup.sh').matchAll(/^ {6}([A-Z_]+)\) [A-Z_]+=\$value ;;$/gm),
    ].map((match) => match[1]);
    assert.ok(known.length >= 8);
    const keys = read('deploy/backup/backup.conf.example')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('=')[0]);
    assert.deepEqual([...keys].sort(), [...known].sort());
    assert.match(read('deploy/backup/backup.conf.example'), /^AGE_RECIPIENT=<CHAVE_PUBLICA_AGE>$/m);
  });

  it('o exemplo do rclone só tem marcadores no lugar da credencial', () => {
    const conf = read('deploy/backup/rclone.conf.example');
    assert.match(conf, /^access_key_id = <[A-Z_]+>$/m);
    assert.match(conf, /^secret_access_key = <[A-Z_]+>$/m);
    assert.match(conf, /^endpoint = https:\/\/<ID_DA_CONTA>\.r2\.cloudflarestorage\.com$/m);
    assert.match(conf, /^no_check_bucket = true$/m);
  });

  it('a unidade roda o programa instalado, como root e com umask fechada; o timer é diário e persistente', () => {
    const unit = read('deploy/backup/soprei-backup.service.example');
    assert.match(unit, /^Type=oneshot$/m);
    assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/soprei-backup$/m);
    assert.match(unit, /^UMask=0077$/m);
    assert.match(unit, /^Environment=PATH=.*\/usr\/sbin.*$/m);
    const timer = read('deploy/backup/soprei-backup.timer.example');
    assert.match(timer, /^OnCalendar=\*-\*-\* 06:30:00 UTC$/m);
    assert.match(timer, /^Persistent=true$/m);
  });

  it('nenhum exemplo nem script traz chave do age, credencial ou endereço real', () => {
    for (const path of [...SCRIPTS, ...EXAMPLES]) {
      const text = read(path);
      assert.doesNotMatch(text, /age1[0-9a-z]{20,}/, path);
      assert.doesNotMatch(text, /AGE-SECRET-KEY-1[0-9A-Z]{10,}/, path);
      assert.doesNotMatch(text, /hc-ping\.com\/[0-9a-f-]{8,}/, path);
      assert.doesNotMatch(text, /[0-9a-f]{32}\.r2\.cloudflarestorage\.com/, path);
    }
  });
});

describe('documentação do backup (spec 043)', () => {
  it('o runbook existe e é citado pelo README e pela seção do deploy do AGENTS.md', () => {
    assert.match(read('docs/ops/backup.md'), /^# Backup do banco fora do servidor \(spec 043\)$/m);
    assert.match(read('README.md'), /\]\(docs\/ops\/backup\.md\)/);
    assert.match(read('AGENTS.md'), /\*\*Backup \(spec 043\):\*\*.*`docs\/ops\/backup\.md`/);
  });
});
