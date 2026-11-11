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

/** Comandos `run:` de uma linha de um job, na ordem. */
function runsOf(job: string): string[] {
  return [...job.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((match) => (match[1] ?? '').trim());
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
