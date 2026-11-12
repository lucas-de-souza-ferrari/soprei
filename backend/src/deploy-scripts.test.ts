import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from './infrastructure/config/parse-config.js';

// Gate de texto da spec 037 (E1 e E2): lê os arquivos de `deploy/` como texto, no modelo de
// `ci-workflow.test.ts`, e falha se uma mudança futura enfraquecer o que o deploy promete (função
// única na última linha, nada de `source` no .env, migration antes do reload, rollback na falha de
// saúde, alvos sem recurso em comum, exemplos sem segredo). O comportamento do script é provado em
// `deploy-script.behavior.test.ts`.
const REPO_ROOT = join(process.cwd(), '..');
const DEPLOY_DIR = join(REPO_ROOT, 'deploy');
const read = (path: string): string =>
  readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n');

const script = read('deploy/deploy.sh');
const scriptLines = script.split('\n');
/** Linhas de código: sem comentários de linha inteira nem linhas em branco. */
const codeLines = scriptLines.filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
const code = codeLines.join('\n');

/** Corpo de uma função do script (da linha `nome() {` até o `}` na coluna 0). */
function functionBody(name: string): string {
  const start = scriptLines.findIndex((line) => line === `${name}() {`);
  assert.ok(start >= 0, `função ${name} ausente em deploy.sh`);
  const end = scriptLines.findIndex((line, index) => index > start && line === '}');
  assert.ok(end > start, `função ${name} sem fechamento`);
  return scriptLines.slice(start + 1, end).join('\n');
}

describe('deploy.sh (spec 037, E1)', () => {
  it('usa set -euo pipefail, umask 077 e LC_ALL=C, e nunca liga o rastreamento do shell', () => {
    assert.match(code, /^set -E?euo pipefail$/m);
    assert.match(code, /^umask 077$/m);
    assert.match(code, /^export LC_ALL=C$/m);
    assert.doesNotMatch(code, /\bset\s+-[A-Za-z]*x/);
    assert.doesNotMatch(code, /\bbash\s+-[A-Za-z]*x/);
  });

  it('toda a lógica está em funções e `main "$@"` é a última linha', () => {
    const lastLine = scriptLines.filter((line) => line.trim() !== '').at(-1);
    assert.equal(lastLine, 'main "$@"');
    assert.equal(script.split('\n').filter((line) => line === 'main "$@"').length, 1);
    // Na coluna 0 só pode haver comentário, atribuição, definição de função, `}` e as opções do shell.
    const topLevel = scriptLines.filter((line) => /^\S/.test(line) && !line.startsWith('#'));
    for (const line of topLevel) {
      assert.match(
        line,
        /^([A-Za-z_][A-Za-z0-9_]*=|readonly |export |set |umask |IFS=|[a-z_0-9]+\(\) \{$|\}$|main "\$@"$)/,
        `comando solto fora de função: ${line}`,
      );
    }
  });

  it('nunca faz source/eval do .env nem imprime o conteúdo dele ou a URL do banco', () => {
    assert.doesNotMatch(code, /^\s*(source|\.)\s+\S/m);
    assert.doesNotMatch(code, /(^|[;&|]\s*)(source|eval)\s/m);
    assert.doesNotMatch(code, /\beval\b/);
    for (const line of codeLines) {
      if (/\b(cat|echo|printf|tee)\b/.test(line)) {
        assert.doesNotMatch(
          line,
          /\.env|ENV_FILE|DATABASE_URL|ENV_VALUE/,
          `linha imprime algo do ambiente: ${line}`,
        );
      }
    }
    // A URL do banco só entra no ambiente de um subshell, nunca como argumento de comando.
    assert.match(code, /export DATABASE_URL=\$ENV_VALUE/);
    assert.doesNotMatch(code, /DATABASE_URL=\S+\s+pnpm/);
    // Os valores saem do arquivo por grep/cut-like, numa função só.
    assert.equal(
      codeLines.filter((line) => /grep -E "\^\(export\[\[:space:\]\]\+\)\?\$1="/.test(line)).length,
      1,
    );
  });

  it('usa flock não bloqueante numa trava global e ignora SIGHUP', () => {
    assert.match(code, /flock -n 9/);
    assert.match(code, /\/var\/lock\/soprei-deploy\.lock/);
    assert.match(code, /trap '' HUP/);
    // Filhos de longa vida não herdam a trava.
    assert.match(functionBody('run_cmd'), /9>&-/);
  });

  it('a migration vem antes do reload, no texto e no fluxo principal', () => {
    assert.ok(code.indexOf('pnpm db:migrate:deploy') >= 0, 'db:migrate:deploy ausente');
    assert.ok(code.indexOf('pm2 startOrReload') >= 0, 'startOrReload ausente');
    assert.ok(code.indexOf('pnpm db:migrate:deploy') < code.indexOf('pm2 startOrReload'));
    const flow = functionBody('run_deploy');
    assert.ok(flow.indexOf('run_migrations') >= 0 && flow.indexOf('reload_app') >= 0);
    assert.ok(
      flow.indexOf('run_migrations') < flow.indexOf('reload_app'),
      'migrar antes de recarregar',
    );
    assert.ok(flow.indexOf('config:check') >= 0, 'o config:check precisa estar no fluxo');
    assert.ok(
      flow.indexOf('check-cli.js') < flow.indexOf('run_migrations'),
      'config:check antes da migration',
    );
  });

  it('há rollback, chamado na falha da espera de saúde, e não roda com --allow-breaking', () => {
    functionBody('rollback_code');
    const flow = functionBody('run_deploy');
    assert.match(flow, /wait_healthy inject \|\| post_swap_failure/);
    assert.match(flow, /site_ok \|\| post_swap_failure/);
    const failure = functionBody('post_swap_failure');
    const breaking = failure.indexOf('ALLOW_BREAKING');
    const rollback = failure.indexOf('rollback_code');
    assert.ok(
      breaking >= 0 && rollback >= 0 && breaking < rollback,
      'checar --allow-breaking antes do rollback',
    );
    assert.match(failure, /manual_intervention/);
    // Falha do rollback = intervenção manual (saída 3), sem tentar de novo.
    assert.match(functionBody('manual_intervention'), /exit 3/);
  });

  it('--inject-health-failure é recusado fora do staging e --env é obrigatório e sem padrão', () => {
    const args = functionBody('parse_args');
    assert.match(args, /INJECT_HEALTH_FAILURE == true && \$ENV_NAME != staging/);
    assert.match(args, /--env é obrigatório/);
    assert.match(code, /^ENV_NAME=''$/m);
    assert.match(args, /ALLOW_UNSTAGED == true && \$ENV_NAME != production/);
  });

  it('espera estabilidade (varias respostas seguidas), prazo e reinício do PM2, sem seguir redirecionamento', () => {
    const wait = functionBody('wait_healthy');
    assert.match(wait, /HEALTH_STABLE_COUNT/);
    assert.match(wait, /HEALTH_TIMEOUT_SECONDS/);
    assert.match(wait, /PM2_RESTARTS > baseline/);
    assert.match(wait, /PM2_STATUS == online/);
    const http = functionBody('http_code');
    assert.match(http, /--max-time 3/);
    assert.doesNotMatch(http, /\s-L\b|--location/);
  });

  it('o filtro de redação cobre URLs de conexão e valores de variáveis sensíveis', () => {
    const redact = functionBody('redact');
    assert.match(redact, /postgres\(ql\)\?/);
    assert.match(redact, /JWT_SECRET/);
    assert.match(redact, /KEY\|SECRET\|TOKEN\|PSWD\|PASSWORD/);
    // Toda a saída passa pelo filtro e vai ao log.
    assert.match(functionBody('main'), /redact \| tee --output-error=warn-nopipe -a "\$LOG_FILE"/);
  });

  it('a queda da conexão (pipe fechado) não mata o deploy: SIGPIPE ignorado no deploy e no filtro', () => {
    assert.match(functionBody('run_deploy'), /trap '' HUP PIPE/);
    assert.match(functionBody('main'), /trap '' INT TERM HUP PIPE/);
  });

  it('a varredura de migrations cobre as palavras do alarme e a marca de aprovação', () => {
    for (const word of [
      'DROP',
      'RENAME',
      'TRUNCATE',
      'SET\\[\\[:space:\\]\\]\\+NOT',
      'DELETE\\[\\[:space:\\]\\]\\+FROM',
      'ALTER\\[\\[:space:\\]\\]\\+COLUMN',
    ]) {
      assert.match(script, new RegExp(word), `padrão ${word} ausente`);
    }
    assert.match(code, /breaking-approved: \.\+/);
  });

  it('o arquivo tem o bit executável no Git', () => {
    let listing: string;
    try {
      listing = execFileSync('git', ['ls-files', '-s', '--', 'deploy/deploy.sh'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return; // sem Git neste ambiente (o CI tem)
    }
    if (listing === '') return; // arquivo ainda não versionado
    assert.match(listing, /^100755 /, 'deploy.sh precisa de git update-index --chmod=+x');
  });

  it('.gitattributes força LF e o .gitignore cobre as pastas de espera do deploy', () => {
    assert.match(read('.gitattributes'), /eol=lf/);
    const ignore = read('.gitignore');
    for (const entry of ['backend/dist.next', 'backend/dist.prev', 'frontend/releases']) {
      assert.ok(ignore.split('\n').includes(entry), `.gitignore sem ${entry}`);
    }
  });
});

describe('deploy.sh --auto (spec 037, E3)', () => {
  it('--auto exige SHA de 40 hexadecimais e recusa as opções que voltam, reimplantam ou liberam', () => {
    const args = functionBody('parse_args');
    assert.match(args, /--auto\) AUTO=true/);
    assert.match(args, /\$REF =~ \^\[0-9a-f\]\{40\}\$/);
    for (const flag of [
      'USE_PREVIOUS',
      'FORCE',
      'ADOPT',
      'ALLOW_BREAKING',
      'INJECT_HEALTH_FAILURE',
    ]) {
      assert.match(args, new RegExp(`\\$${flag} == true`), `--auto não recusa ${flag}`);
    }
  });

  it('depois do fetch, o SHA precisa estar na main e não pode ser mais antigo', () => {
    const rules = functionBody('check_auto_rules');
    assert.match(rules, /merge-base --is-ancestor "\$TARGET_SHA" refs\/remotes\/origin\/main/);
    assert.match(rules, /merge-base --is-ancestor "\$PREV_SHA" "\$TARGET_SHA"/);
    const flow = functionBody('run_deploy');
    const fetch = flow.indexOf('fetch --prune --tags origin');
    const auto = flow.indexOf('check_auto_rules');
    assert.ok(fetch >= 0 && auto > fetch, 'as regras do --auto vêm depois do fetch');
    assert.ok(auto < flow.indexOf('scan_migrations'), 'e antes de qualquer outra etapa');
    assert.match(flow, /modo=\$mode/);
  });

  it('no --auto o --ref só resolve como o próprio SHA (nunca branch ou tag com esse nome)', () => {
    const resolve = functionBody('resolve_ref');
    const auto = resolve.indexOf('AUTO == true');
    const candidates = resolve.indexOf('refs/remotes/origin/$REF');
    assert.ok(auto >= 0 && auto < candidates, 'o ramo do --auto vem antes dos candidatos');
    assert.match(resolve, /rev-parse --verify --quiet "\$REF\^\{commit\}"/);
    assert.match(resolve, /\$TARGET_SHA == "\$REF"/);
  });
});

const entry = read('deploy/soprei-deploy-entry.sh');
const entryLines = entry.split('\n');
const entryCode = entryLines.filter((line) => line.trim() !== '' && !/^\s*#/.test(line)).join('\n');

describe('programa de entrada do deploy automático (spec 037, E3)', () => {
  it('usa set -euo pipefail, nunca source, eval nem set -x, e termina em main "$@"', () => {
    assert.match(entryCode, /^set -euo pipefail$/m);
    assert.match(entryCode, /^umask 077$/m);
    assert.doesNotMatch(entryCode, /^\s*(source|\.)\s+\S/m);
    assert.doesNotMatch(entryCode, /\beval\b/);
    assert.doesNotMatch(entryCode, /\bset\s+-[A-Za-z]*x/);
    assert.equal(entryLines.filter((line) => line.trim() !== '').at(-1), 'main "$@"');
  });

  it('caminhos em constantes no topo (as únicas linhas que o teste troca por dublês)', () => {
    for (const constant of [
      'readonly SUDO=/usr/bin/sudo',
      'readonly SELF=/usr/local/sbin/soprei-deploy-entry',
      'readonly DEPLOY=/var/www/soprei/deploy/deploy.sh',
      'readonly CONF=/etc/soprei-deploy/entry.conf',
      'readonly REQUIRE_ROOT=true',
    ]) {
      assert.equal(entryLines.filter((line) => line === constant).length, 1, constant);
    }
    // Nenhuma variável de ambiente muda o comportamento: só SSH_ORIGINAL_COMMAND é lida.
    const envReads = [...entryCode.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1] ?? '')
      .filter(
        (name) =>
          ![
            'SUDO',
            'SELF',
            'DEPLOY',
            'CONF',
            'LOGGER',
            'REQUIRE_ROOT',
            'REQUEST_RE',
            'SHA_RE',
            'MAX_REQUEST_LENGTH',
            'ENABLED',
            'ALLOW_UNSTAGED',
            'MIGRATIONS',
            'BASH_REMATCH',
            'EUID',
          ].includes(name),
      );
    assert.deepEqual([...new Set(envReads)], ['SSH_ORIGINAL_COMMAND']);
  });

  it('aceita só o formato ancorado e chama o deploy.sh com --auto pelo env -i', () => {
    assert.ok(
      entry.includes("readonly REQUEST_RE='^--env production --ref ([0-9a-f]{40})( --dry-run)?$'"),
    );
    assert.match(entryCode, /exec "\$SUDO" -n "\$SELF" --from-ssh "\$sha" "\$mode"/);
    assert.match(
      entryCode,
      /exec \/usr\/bin\/env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin HOME=\/root LC_ALL=C "\$DEPLOY" "\$\{args\[@\]\}"/,
    );
    assert.match(entryCode, /args=\(--env production --ref "\$sha" --auto\)/);
    assert.doesNotMatch(entryCode, /--allow-breaking|--force|--previous|--adopt/);
  });

  it('o arquivo tem o bit executável no Git', () => {
    let listing: string;
    try {
      listing = execFileSync('git', ['ls-files', '-s', '--', 'deploy/soprei-deploy-entry.sh'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return;
    }
    if (listing === '') return;
    assert.match(listing, /^100755 /);
  });
});

describe('exemplos do servidor para o deploy automático (spec 037, E3)', () => {
  const nonComment = (text: string): string[] =>
    text.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

  it('sudoers: só a fase de dentro do programa de entrada, como root, sem senha', () => {
    const rules = nonComment(read('deploy/sudoers/soprei-deploy.example'));
    const grants = rules.filter((line) => !line.startsWith('Defaults'));
    assert.deepEqual(grants, [
      'soprei-deploy ALL=(root) NOPASSWD: /usr/local/sbin/soprei-deploy-entry --from-ssh *',
    ]);
    for (const line of rules.filter((item) => item.startsWith('Defaults'))) {
      assert.match(line, /^Defaults:soprei-deploy (env_reset|!requiretty)$/);
    }
  });

  it('sshd: ForceCommand, só chave pública, sem encaminhamento, terminal nem rc', () => {
    const rules = nonComment(read('deploy/ssh/sshd-soprei-deploy.conf.example')).map((line) =>
      line.trim(),
    );
    assert.equal(rules[0], 'Match User soprei-deploy');
    for (const directive of [
      'ForceCommand /usr/local/sbin/soprei-deploy-entry',
      'AuthenticationMethods publickey',
      'PasswordAuthentication no',
      'DisableForwarding yes',
      'PermitTTY no',
    ]) {
      assert.ok(rules.includes(directive), `sshd sem ${directive}`);
    }
  });

  it('authorized_keys: restrict e command= com marcador no lugar da chave', () => {
    const keys = nonComment(read('deploy/ssh/authorized_keys.example'));
    assert.deepEqual(keys, [
      'restrict,command="/usr/local/sbin/soprei-deploy-entry" ssh-ed25519 <CHAVE_PUBLICA_DO_DEPLOY> soprei-github-deploy',
    ]);
  });

  it('entry.conf: só as três chaves, com os valores das decisões D15 e D16', () => {
    const pairs = nonComment(read('deploy/entry/entry.conf.example'));
    assert.deepEqual(pairs, ['ENABLED=true', 'ALLOW_UNSTAGED=true', 'MIGRATIONS=auto']);
  });
});

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

describe('deploy/: nenhum arquivo contém segredo, e-mail nem IP do servidor', () => {
  const files = listFiles(DEPLOY_DIR);

  it('há arquivos para varrer', () => {
    assert.ok(files.length >= 10, `só ${String(files.length)} arquivos em deploy/`);
  });

  for (const file of files) {
    const name = relative(REPO_ROOT, file).replaceAll('\\', '/');
    it(name, () => {
      const text = readFileSync(file, 'utf8');
      // NOME_SENSIVEL=valor (marcador <ASSIM> e valor vazio são permitidos).
      assert.doesNotMatch(
        text,
        /\b(?:JWT_SECRET|[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PSWD|PASSWORD))=(?![<\s]|$)\S+/m,
        'valor atribuído a variável de nome sensível',
      );
      // URL de conexão com credencial embutida (senha que não seja marcador).
      assert.doesNotMatch(text, /\b(?:postgres(?:ql)?|redis):\/\/[^:@\s/]*:[^@\s<]+@/);
      // Nenhum endereço de e-mail e nenhum IPv4 além do loopback.
      assert.doesNotMatch(text, /[A-Za-z0-9._-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/);
      for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        assert.ok(ip === '127.0.0.1', `endereço IP fora do loopback: ${ip}`);
      }
      // Chaves privadas coladas por engano.
      assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/);
    });
  }
});

const require = createRequire(import.meta.url);

describe('ecosystem.config.cjs (spec 037, D7)', () => {
  const ecosystem = require(join(DEPLOY_DIR, 'ecosystem.config.cjs')) as {
    apps: {
      name: string;
      script: string;
      cwd: string;
      exec_mode: string;
      instances: number;
      kill_timeout: number;
      max_memory_restart: string;
      env: Record<string, string>;
    }[];
  };
  const shutdownDefault = (() => {
    const result = parseConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379/0',
      JWT_SECRET: 'j'.repeat(32),
    });
    assert.ok(result.ok);
    return result.value.SHUTDOWN_TIMEOUT_MS;
  })();

  it('declara os apps de produção e staging, em fork, com 1 instância', () => {
    assert.deepEqual(
      ecosystem.apps.map((app) => app.name),
      ['soprei-api', 'soprei-staging'],
    );
    for (const app of ecosystem.apps) {
      assert.equal(app.exec_mode, 'fork');
      assert.equal(app.instances, 1);
      assert.equal(app.script, 'dist/index.js');
      assert.ok(
        app.cwd.endsWith('/backend'),
        'o cwd é o backend (o dotenv lê o .env do diretório atual)',
      );
    }
  });

  it('kill_timeout cobre o SHUTDOWN_TIMEOUT_MS padrão e max_memory_restart é por app (staging menor)', () => {
    for (const app of ecosystem.apps) {
      assert.ok(
        app.kill_timeout >= shutdownDefault,
        `${app.name}: kill_timeout ${String(app.kill_timeout)} < ${String(shutdownDefault)}`,
      );
      assert.match(app.max_memory_restart, /^\d+[MG]$/);
    }
    const [production, staging] = ecosystem.apps;
    assert.equal(production?.max_memory_restart, '1G');
    assert.equal(staging?.max_memory_restart, '700M');
  });

  it('cwd diferente por ambiente e env só com variável não sensível', () => {
    const [production, staging] = ecosystem.apps;
    assert.notEqual(production?.cwd, staging?.cwd);
    for (const app of ecosystem.apps) {
      for (const key of Object.keys(app.env)) {
        assert.equal(
          key,
          'NODE_EXTRA_CA_CERTS',
          `variável inesperada no env de ${app.name}: ${key}`,
        );
      }
    }
    assert.equal(production?.env['NODE_EXTRA_CA_CERTS'], undefined);
  });
});

function parseTarget(name: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of read(`deploy/targets/${name}.conf`).split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    assert.ok(separator > 0, `linha inválida em ${name}.conf: ${line}`);
    map.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return map;
}

describe('deploy/targets (spec 037)', () => {
  const production = parseTarget('production');
  const staging = parseTarget('staging');
  const scriptKeys = new Set(
    [...functionBody('load_target').matchAll(/^ {6}([A-Z0-9_]+)\) /gm)].map(
      (match) => match[1] ?? '',
    ),
  );

  it('só usam chaves que o script conhece, com valores sem espaço, aspas nem cifrão', () => {
    for (const [name, target] of [
      ['production', production],
      ['staging', staging],
    ] as const) {
      for (const [key, value] of target) {
        assert.ok(scriptKeys.has(key), `${name}.conf: chave desconhecida do script: ${key}`);
        assert.match(
          value,
          /^[A-Za-z0-9_./:@%+,-]*$/,
          `${name}.conf: valor de ${key} com caractere proibido`,
        );
      }
    }
  });

  it('staging e produção não compartilham porta, app do PM2, diretório, .env nem URL de saúde', () => {
    for (const key of [
      'PORT',
      'PM2_APP',
      'APP_DIR',
      'ENV_FILE',
      'HEALTH_URL',
      'READY_URL',
      'SITE_HOST',
    ]) {
      const a = production.get(key);
      const b = staging.get(key);
      assert.ok(a !== undefined && b !== undefined, `${key} ausente em algum alvo`);
      assert.notEqual(a, b, `${key} igual nos dois alvos`);
    }
    for (const target of [production, staging]) {
      assert.equal(target.get('ENV_FILE'), `${target.get('APP_DIR') ?? ''}/backend/.env`);
    }
    assert.equal(production.get('PORT'), '3001');
    assert.equal(staging.get('PORT'), '3002');
  });

  it('o staging não nomeia o banco soprei nem a porta 6379 do Redis da produção', () => {
    const text = read('deploy/targets/staging.conf')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    assert.doesNotMatch(text, /(?<![\w.-])soprei(?![\w.-])/);
    assert.doesNotMatch(text, /6379/);
  });

  it('a produção exige que o SHA passe pelo staging (D8) e o staging não', () => {
    assert.equal(production.get('REQUIRE_STAGED'), 'true');
    assert.equal(staging.get('REQUIRE_STAGED'), 'false');
    assert.equal(staging.get('PRE_MIGRATION_BACKUP'), undefined);
  });

  it('o ecosystem e os alvos concordam no nome do app e no diretório', () => {
    const ecosystem = require(join(DEPLOY_DIR, 'ecosystem.config.cjs')) as {
      apps: { name: string; cwd: string }[];
    };
    for (const target of [production, staging]) {
      const app = ecosystem.apps.find((item) => item.name === target.get('PM2_APP'));
      assert.ok(app, `app ${target.get('PM2_APP') ?? ''} ausente no ecosystem`);
      assert.equal(app.cwd, `${target.get('APP_DIR') ?? ''}/backend`);
    }
  });
});

describe('exemplos do staging (spec 037, E2)', () => {
  it('Redis do staging: porta própria, só loopback, AOF, noeviction e senha por marcador', () => {
    const conf = read('deploy/redis/redis-staging.conf.example');
    const directive = (name: string): string | undefined =>
      conf
        .split('\n')
        .find((line) => line.startsWith(`${name} `))
        ?.slice(name.length + 1)
        .trim();
    assert.equal(directive('port'), '6380');
    assert.notEqual(directive('port'), '6379');
    assert.equal(directive('bind'), '127.0.0.1');
    assert.equal(directive('appendonly'), 'yes');
    assert.equal(directive('appendfsync'), 'everysec');
    assert.equal(directive('maxmemory-policy'), 'noeviction');
    assert.equal(directive('dir'), '/var/lib/redis-staging');
    assert.match(
      directive('requirepass') ?? '',
      /^<[A-Z_]+>$/,
      'a senha é um marcador, nunca um valor',
    );
    assert.ok(!conf.includes('6379'));
    const unit = read('deploy/redis/redis-staging.service.example');
    assert.match(unit, /\/etc\/redis-staging\/redis\.conf/);
  });

  it('Mailpit do staging: SMTP e interface só no loopback, STARTTLS obrigatório e limite de mensagens', () => {
    const unit = read('deploy/mailpit/mailpit-staging.service.example');
    assert.match(unit, /--smtp 127\.0\.0\.1:1025/);
    assert.match(unit, /--listen 127\.0\.0\.1:8025/);
    assert.match(unit, /--smtp-require-starttls/);
    assert.match(unit, /--max \d+/);
  });

  it('nginx do staging: senha básica, noindex, sem Authorization na API e só a porta 3002', () => {
    const conf = read('deploy/nginx/staging.conf.example');
    assert.match(conf, /^\s*auth_basic "[^"]+";$/m);
    assert.match(conf, /^\s*auth_basic_user_file \/etc\/nginx\/[\w.-]+;$/m);
    assert.match(conf, /add_header X-Robots-Tag "noindex, nofollow" always;/);
    const proxied = conf.split('\n').filter((line) => line.includes('proxy_pass'));
    assert.equal(proxied.length, 2);
    for (const line of proxied) assert.match(line, /127\.0\.0\.1:3002/);
    assert.equal(conf.split('proxy_set_header Authorization "";').length - 1, 2);
    assert.doesNotMatch(conf, /:3001|:6379/);
    const production = read('deploy/nginx/production.conf.example');
    assert.doesNotMatch(production, /auth_basic|3002/);
  });

  const envExample = read('deploy/env/staging.env.example')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'));
  const pairs = envExample.map((line): [string, string] => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  const declared = new Map(pairs);

  it('.env do staging: valores fixos de isolamento e nenhuma variável de serviço externo', () => {
    assert.equal(declared.get('NODE_ENV'), 'production');
    assert.equal(declared.get('LLM_PROVIDER'), 'mock');
    assert.equal(declared.get('WHATSAPP_ENABLED'), 'false');
    assert.equal(declared.get('BILLING_ENABLED'), 'false');
    assert.equal(declared.get('CHECKOUT_ENABLED'), 'false');
    assert.equal(declared.get('SCHEDULE_AI_ENABLED'), 'false');
    assert.equal(declared.get('PORT'), '3002');
    assert.equal(declared.get('HOST'), '127.0.0.1');
    assert.match(declared.get('REDIS_URL') ?? '', /@127\.0\.0\.1:6380\/0$/);
    assert.match(declared.get('DATABASE_URL') ?? '', /\/soprei_staging$/);
    for (const name of declared.keys()) {
      assert.doesNotMatch(
        name,
        /^(INFINITEPAY_|ANTHROPIC_|CHANNEL_|WHATSAPP_(?!ENABLED$))/,
        `variável proibida no staging: ${name}`,
      );
    }
    assert.ok(!declared.has('CHANNEL_MANUAL_CONNECT_ENABLED'));
  });

  it('.env do staging preenchido com valores sintéticos passa em parseConfig (o mesmo schema do boot)', () => {
    const synthetic: Record<string, string> = {
      JWT_SECRET: 'j'.repeat(40),
      METRICS_TOKEN: 'm'.repeat(40),
    };
    const fill = (name: string, value: string): string =>
      synthetic[name] ??
      value
        .replace(/<HOSTNAME_DO_STAGING>/g, 'staging.exemplo.test')
        .replace(/<[A-Z_]+>/g, 'sintetico123');
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of pairs) env[name] = fill(name, value);
    const result = parseConfig(env);
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    assert.equal(result.value.NODE_ENV, 'production');
    assert.equal(result.value.LLM_PROVIDER, 'mock');
    assert.equal(result.value.WHATSAPP_ENABLED, false);
    assert.equal(result.value.ACCOUNTS_ENABLED, true);

    // O teste não é vazio: sem a origem o mesmo ambiente deixa de valer.
    const incomplete = { ...env };
    delete incomplete['APP_ORIGIN'];
    assert.ok(!parseConfig(incomplete).ok);
  });
});

describe('documentação operacional (spec 037)', () => {
  it('docs/ops/deploy.md descreve os códigos de saída, a política de migration e a proibição de dump de produção no staging', () => {
    const doc = read('docs/ops/deploy.md');
    for (const text of [
      '--dry-run',
      '--adopt',
      '--allow-breaking',
      'breaking-approved',
      'INTERVENÇÃO MANUAL',
      'dump',
    ]) {
      assert.ok(doc.includes(text), `docs/ops/deploy.md sem ${text}`);
    }
    for (const code of ['| 0 ', '| 1 ', '| 2 ', '| 3 ']) {
      assert.ok(doc.includes(code), `docs/ops/deploy.md sem a linha de código de saída ${code}`);
    }
  });

  it('docs/ops/deploy.md descreve o deploy automático, os passos do dono e como desligar (E3)', () => {
    const doc = read('docs/ops/deploy.md');
    for (const text of [
      '## Deploy automático pelo GitHub Actions (E3)',
      '### Passos do dono, em ordem',
      '### Desligar numa emergência',
      '--auto',
      'DEPLOY_ENABLED',
      'ENABLED=false',
      'soprei-deploy-entry',
      '| 64 ',
      '| 255 ',
    ]) {
      assert.ok(doc.includes(text), `docs/ops/deploy.md sem ${text}`);
    }
    assert.ok(!doc.includes('E3, adiada'), 'a linha antiga sobre a E3 adiada precisa sair');
  });
});
