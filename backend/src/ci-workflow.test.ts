import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Gate do pipeline (spec 036): o CI ficou rápido separando jobs, rodando numa só versão do Node e
// fatiando o Playwright. Este teste lê os arquivos como texto (sem dependência de YAML) e falha se
// uma mudança futura tirar um comando da suíte, voltar a matriz de versões aos PRs ou soltar a
// concorrência da integração. Não substitui a execução real: tempos e contagens são conferidos no CI.
const REPO_ROOT = join(process.cwd(), '..');
const read = (path: string): string =>
  readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n');

const ci = read('.github/workflows/ci.yml');
const compat = read('.github/workflows/node-compat.yml');
const playwrightConfig = read('frontend/playwright.config.ts');

/** Texto de cada job de `ci.yml`, pela chave de dois espaços sob `jobs:`. */
function jobsOf(workflow: string): Map<string, string> {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const jobs = new Map<string, string>();
  let current: string | undefined;
  for (const line of body.split('\n')) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      jobs.set(current, '');
    } else if (current !== undefined) {
      jobs.set(current, `${jobs.get(current) ?? ''}${line}\n`);
    }
  }
  return jobs;
}

/** Comandos `run:` de uma linha de um job, na ordem (blocos `run: |` ficam de fora). */
function runsOf(job: string): string[] {
  return [...job.matchAll(/^\s+(?:- )?run: (.+)$/gm)]
    .map((match) => (match[1] ?? '').trim())
    .filter((run) => !/^[|>][-+]?$/.test(run));
}

const jobs = jobsOf(ci);
const job = (name: string): string => {
  const text = jobs.get(name);
  assert.ok(text !== undefined, `job ${name} ausente em ci.yml`);
  return text;
};

describe('pipeline do CI (spec 036)', () => {
  it('usa uma só versão do Node, a do .nvmrc, compatível com engines', () => {
    const nvmrc = read('.nvmrc').trim();
    assert.match(nvmrc, /^\d+$/, '.nvmrc deve ter só a major');
    for (const path of ['package.json', 'backend/package.json']) {
      const pkg = JSON.parse(read(path)) as { engines?: { node?: string } };
      const floor = /^>=(\d+)$/.exec(pkg.engines?.node ?? '');
      assert.ok(floor?.[1] !== undefined, `${path}: engines.node fora do formato >=N`);
      assert.ok(Number(nvmrc) >= Number(floor[1]), `${path}: .nvmrc abaixo de engines.node`);
    }
    assert.ok(!ci.includes('matrix.node'), 'ci.yml não deve ter matriz de versões do Node');
    assert.ok(!ci.includes('lts/*'), 'ci.yml não deve citar lts/*');
    for (const name of ['static', 'tests', 'browser']) {
      assert.match(job(name), /node-version-file: \.nvmrc/, `${name} não lê o .nvmrc`);
    }
  });

  it('tem os jobs static, tests e browser, e só tests declara services', () => {
    assert.deepEqual([...jobs.keys()], ['static', 'tests', 'browser']);
    assert.match(job('tests'), /^ {4}services:$/m);
    assert.match(job('tests'), /image: postgres:/);
    assert.match(job('tests'), /image: redis:/);
    assert.doesNotMatch(job('static'), /^\s+services:/m);
    assert.doesNotMatch(job('browser'), /^\s+services:/m);
  });

  it('nenhum comando da suíte ficou de fora', () => {
    assert.deepEqual(
      runsOf(job('static')).filter((run) => run !== 'nproc'),
      [
        'pnpm install --frozen-lockfile',
        'pnpm db:generate',
        'pnpm typecheck',
        'pnpm lint',
        'pnpm format:check',
        'shellcheck deploy/*.sh',
        'shellcheck deploy/backup/*.sh',
        'actionlint',
        'pnpm build',
      ],
    );
    assert.deepEqual(
      runsOf(job('tests')).filter((run) => run !== 'nproc'),
      [
        'pnpm install --frozen-lockfile',
        'pnpm db:generate',
        'pnpm db:migrate:deploy',
        'pnpm test',
        'pnpm test:integration',
      ],
    );
    assert.ok(
      runsOf(job('browser')).some((run) =>
        run.startsWith('pnpm --filter soprei-frontend test:browser'),
      ),
      'browser não roda test:browser',
    );
  });

  it('actionlint (spec 037, E3): versão fixa, SHA-256 conferido antes de extrair, instalado antes de rodar', () => {
    const text = job('static');
    const install = text.indexOf('- name: Instalar o actionlint');
    const run = text.indexOf('- run: actionlint\n');
    assert.ok(install >= 0, 'passo de instalação do actionlint ausente no job static');
    assert.ok(run > install, 'o actionlint roda depois de instalado');
    assert.ok(text.indexOf('- run: shellcheck deploy/*.sh') < install, 'depois do shellcheck');
    const step = text.slice(install, run);
    assert.match(step, /ACTIONLINT_VERSION: \d+\.\d+\.\d+\n/, 'versão fixa (nunca latest)');
    assert.match(step, /ACTIONLINT_SHA256: [0-9a-f]{64}\n/);
    assert.match(step, /releases\/download\/v\$\{ACTIONLINT_VERSION\}\//);
    assert.doesNotMatch(step, /latest/);
    const check = step.indexOf('sha256sum --check --strict');
    const extract = step.indexOf('tar -xzf');
    assert.ok(check >= 0 && extract > check, 'a soma é conferida antes de extrair');
    assert.match(step, /set -euo pipefail/);
    assert.match(
      text.slice(0, install),
      /actionlint_\d+\.\d+\.\d+_checksums\.txt.*\n.*github\.com\/rhysd\/actionlint\/releases\/tag\/v/,
      'fonte da soma registrada no comentário do passo',
    );
  });

  it('cancela a execução anterior só em pull_request', () => {
    const block = /^concurrency:\n((?: {2}.+\n)+)/m.exec(ci)?.[1] ?? '';
    assert.match(block, /group: .*github\.event\.pull_request\.number \|\| github\.ref/);
    assert.match(block, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  it('Playwright: fullyParallel, 1 worker no CI, uma retentativa e fatias vindas da matriz', () => {
    assert.match(playwrightConfig, /fullyParallel: true,/);
    assert.match(playwrightConfig, /workers: process\.env\.CI \? 1 : undefined,/);
    assert.match(playwrightConfig, /retries: process\.env\.CI \? 1 : 0,/);
    assert.match(job('browser'), /^ {8}shard: \[1, 2, 3\]$/m);
    assert.ok(
      job('browser').includes('test:browser --shard=${{ matrix.shard }}/${{ strategy.job-total }}'),
      'a fatia e o total devem vir da matriz',
    );
    assert.match(job('browser'), /fail-fast: false/);
    assert.match(job('browser'), /name: playwright-traces-\$\{\{ matrix\.shard \}\}/);
  });

  it('cache do navegador pela versão instalada do Playwright, sem chave parcial', () => {
    const browser = job('browser');
    assert.match(browser, /path: ~\/\.cache\/ms-playwright/);
    assert.match(browser, /playwright --version/);
    assert.match(
      browser,
      /key: \$\{\{ runner\.os \}\}-playwright-\$\{\{ steps\.playwright\.outputs\.version \}\}/,
    );
    assert.doesNotMatch(browser, /^\s+restore-keys:/m);
    assert.match(
      browser,
      /if: steps\.browsers\.outputs\.cache-hit != 'true'\n\s+run: .*playwright install chromium/,
    );
    // O apt (bibliotecas do sistema) saiu do caminho: falhou por DNS do runner e só trazia fontes extras.
    assert.ok(
      !runsOf(browser).some((run) => /install-deps|--with-deps|apt(-get)? /.test(run)),
      'o job browser não deve depender do apt',
    );
  });

  it('admin da plataforma (spec 044, E4): os scripts da raiz que o static e o tests rodam incluem o admin', () => {
    const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const script of ['typecheck', 'lint', 'build', 'test']) {
      assert.match(
        root.scripts[script] ?? '',
        /--filter soprei-admin \w+/,
        `o script ${script} da raiz não inclui o admin`,
      );
    }
    // O format:check percorre a raiz inteira (admin incluído).
    assert.match(root.scripts['format:check'] ?? '', /prettier --check \.\. /);
    const admin = JSON.parse(read('admin/package.json')) as { scripts: Record<string, string> };
    for (const script of ['typecheck', 'lint', 'build', 'test', 'test:browser']) {
      assert.ok(admin.scripts[script], `admin/package.json sem o script ${script}`);
    }
  });

  it('admin da plataforma (spec 044, E4): o browser roda as fatias do admin com o mesmo navegador', () => {
    const browser = job('browser');
    assert.match(
      browser,
      /- if: \$\{\{ !cancelled\(\) \}\}\n\s+run: pnpm --filter soprei-admin test:browser --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\n/,
      'browser não roda as fatias do admin (ou só roda se o site passou)',
    );
    assert.match(browser, /pnpm --filter soprei-admin exec playwright --version/);
    assert.match(browser, /name: playwright-traces-admin-\$\{\{ matrix\.shard \}\}/);
    assert.match(browser, /path: admin\/test-results/);

    const adminConfig = read('admin/playwright.config.ts');
    assert.match(adminConfig, /fullyParallel: true,/);
    assert.match(adminConfig, /workers: process\.env\.CI \? 1 : undefined,/);
    assert.match(adminConfig, /retries: process\.env\.CI \? 1 : 0,/);
    // No CI (Linux) o Chromium do Playwright, o do cache; o Edge do sistema só no Windows local.
    const channels = [...adminConfig.matchAll(/channel: '([^']+)'/g)];
    assert.equal(channels.length, 1);
    assert.match(adminConfig, /process\.platform === 'win32' \? \{ channel: 'msedge' \} : \{\}/);
    assert.doesNotMatch(adminConfig, /browserName: '(?!chromium)/);
  });

  it('a integração continua com um arquivo por vez', () => {
    const pkg = JSON.parse(read('backend/package.json')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['test:integration'] ?? '', /--test-concurrency=1\b/);
  });

  it('a compatibilidade com outras versões do Node é semanal e fora dos PRs', () => {
    const triggers = /^on:\n((?: {2}.*\n|\n)+?)(?=\S)/m.exec(compat)?.[1] ?? '';
    assert.match(triggers, /^ {2}schedule:$/m);
    assert.match(triggers, /cron: '\S+ \S+ \* \* [0-6]'/);
    assert.match(triggers, /^ {2}workflow_dispatch:$/m);
    assert.doesNotMatch(triggers, /pull_request|push/);
    assert.match(compat, /uses: \.\/\.github\/workflows\/ci\.yml/);
    assert.match(compat, /node: '22'/);
    assert.match(compat, /node: lts\/\*/);
    assert.match(ci, /^ {2}workflow_call:$/m);
  });
});
