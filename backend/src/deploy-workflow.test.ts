import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Gate de texto do deploy automático (spec 037, E3), irmão de `ci-workflow.test.ts`: lê o
// `.github/workflows/deploy.yml` como texto (sem dependência de YAML) e falha se uma mudança futura
// abrir um gatilho de PR, pedir permissão de escrita, trouxer uma ação de terceiros, puser um valor do
// evento dentro de um script, afrouxar o SSH ou deixar o disparo manual publicar. Não substitui o
// `actionlint` (passo do job `static`) nem os testes manuais do dono.
const REPO_ROOT = join(process.cwd(), '..');
const read = (path: string): string =>
  readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n');

const workflow = read('.github/workflows/deploy.yml');
const lines = workflow.split('\n');
/** Texto sem as linhas de comentário (o comentário do topo pode citar o que é proibido). */
const code = lines.filter((line) => !/^\s*#/.test(line)).join('\n');

/** Bloco de uma chave de topo (`on:`, `jobs:`...), até a próxima chave de topo. */
function topBlock(key: string): string {
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  assert.ok(start >= 0, `chave ${key} ausente em deploy.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line) && !line.startsWith('#'));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** Conteúdo de cada `run:` (uma linha ou bloco `|`), na ordem. */
function runBlocks(): string[] {
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s+)(?:- )?run: (.*)$/.exec(lines[index] ?? '');
    if (!match) continue;
    const value = match[2] ?? '';
    if (!/^[|>][-+]?$/.test(value)) {
      blocks.push(value);
      continue;
    }
    const indent = (match[1] ?? '').length;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? '';
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('deploy.yml (spec 037, E3)', () => {
  it('gatilhos: só workflow_run do CI (completed, main) e workflow_dispatch com o SHA', () => {
    const on = topBlock('on');
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
    assert.deepEqual(triggers, ['workflow_run', 'workflow_dispatch']);
    assert.match(on, /^ {4}workflows: \[CI\]$/m);
    assert.match(on, /^ {4}types: \[completed\]$/m);
    assert.match(on, /^ {4}branches: \[main\]$/m);
    assert.match(on, /^ {6}sha:$/m);
    for (const forbidden of [
      'pull_request_target',
      'pull_request',
      'push:',
      'schedule',
      'issue_comment',
      'repository_dispatch',
    ]) {
      assert.ok(!code.includes(forbidden), `gatilho proibido: ${forbidden}`);
    }
  });

  it('o CI continua com o nome que o workflow_run procura', () => {
    assert.match(read('.github/workflows/ci.yml'), /^name: CI$/m);
  });

  it('permissões: nada no topo e só leitura no job', () => {
    assert.match(code, /^permissions: \{\}$/m);
    const jobPermissions = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(code)?.[1] ?? '';
    const granted = jobPermissions
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.trim());
    // Ler a ponta da main pela API só precisa de contents: read (revisão da E3, sugestão 5).
    assert.deepEqual(granted, ['contents: read']);
    assert.doesNotMatch(code, /:\s*write\b/);
    assert.equal(
      [...code.matchAll(/^ *permissions:/gm)].length,
      2,
      'permissions só no topo e no job',
    );
  });

  it('um job só, no ambiente production, com prazo e concorrência que nunca cancela o andamento', () => {
    const jobs = [...topBlock('jobs').matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(jobs, ['deploy']);
    assert.match(code, /^ {4}environment: production$/m);
    assert.match(code, /^ {4}timeout-minutes: \d+$/m);
    const concurrency = topBlock('concurrency');
    // O dry-run manual tem grupo próprio: nunca tira da fila um deploy real pendente.
    assert.match(concurrency, /^ {2}group: deploy-production-\$\{\{ github\.event_name \}\}$/m);
    assert.match(concurrency, /^ {2}cancel-in-progress: false$/m);
  });

  it('o if do job é exatamente o esperado: CI verde, push na main deste repositório e o interruptor ligado', () => {
    const condition = /^ {4}if: >-\n((?: {6}.+\n)+)/m.exec(code)?.[1] ?? '';
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    // Comparação do texto inteiro: uma disjunção a mais (como "|| true") ou uma condição a menos falha.
    assert.equal(
      normalize(condition),
      normalize(`
        vars.DEPLOY_ENABLED == 'true' && (
          (github.event_name == 'workflow_run' &&
            github.event.workflow_run.conclusion == 'success' &&
            github.event.workflow_run.event == 'push' &&
            github.event.workflow_run.head_branch == 'main' &&
            github.event.workflow_run.head_repository.full_name == github.repository) ||
          (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')
        )`),
    );
  });

  it('nenhuma ação (uses:), nenhum checkout e nenhum valor do evento dentro de um script', () => {
    assert.doesNotMatch(code, /^\s+(?:- )?uses:/m);
    assert.ok(!code.includes('checkout'));
    const runs = runBlocks();
    assert.ok(runs.length >= 4, `só ${String(runs.length)} passos run`);
    for (const run of runs) {
      assert.ok(!run.includes('${{'), `run com expressão do GitHub: ${run.slice(0, 60)}`);
      assert.doesNotMatch(run, /\bset\s+-[A-Za-z]*x/, 'set -x proibido');
    }
    // O SHA é conferido antes de qualquer uso, nos dois passos que o recebem.
    assert.equal(runs.filter((run) => run.includes('^[0-9a-f]{40}$')).length >= 2, true);
  });

  it('só os três segredos do deploy e o token do próprio job', () => {
    const secrets = new Set([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]));
    assert.deepEqual(
      [...secrets].sort(),
      ['DEPLOY_SSH_HOST', 'DEPLOY_SSH_KEY', 'DEPLOY_SSH_KNOWN_HOSTS'].sort(),
    );
    assert.doesNotMatch(code, /secrets: inherit|toJSON\(secrets\)/);
    assert.match(code, /DEPLOY_SSH_USER: \$\{\{ vars\.DEPLOY_SSH_USER \}\}/);
  });

  it('o ssh confere a chave do servidor, não pergunta nada e usa só a chave do segredo', () => {
    const ssh = runBlocks().find((run) => /^\s*ssh /m.test(run)) ?? '';
    assert.ok(ssh !== '', 'passo do ssh ausente');
    for (const option of [
      '-o StrictHostKeyChecking=yes',
      '-o BatchMode=yes',
      '-o IdentitiesOnly=yes',
      '-o UserKnownHostsFile=',
      '-o GlobalKnownHostsFile=/dev/null',
      '-F /dev/null',
      '-T ',
    ]) {
      assert.ok(ssh.includes(option), `ssh sem ${option}`);
    }
    assert.doesNotMatch(ssh, /StrictHostKeyChecking=(no|accept-new)|ssh-keyscan/);
    // O pedido é exatamente o formato que o programa de entrada aceita.
    assert.match(ssh, /request="--env production --ref \$SHA"/);
    assert.match(ssh, /request="\$request --dry-run"/);
    // O pedido começa com "-": sem "--" antes do destino o programa ssh o relê como opção e sai com 255
    // ("unknown option -- -"), sem chegar ao servidor (achado na configuração do servidor, 2026-11-12).
    assert.match(ssh, /-T -- "\$DEPLOY_SSH_USER@\$DEPLOY_SSH_HOST" "\$request"/);
    assert.doesNotMatch(ssh, /--force|--allow-breaking|--previous|--adopt|--auto/);
  });

  it('a chave vai para o RUNNER_TEMP com umask 077 e um passo com if: always() a apaga', () => {
    const blocks = runBlocks();
    const prepare = blocks.find((run) => run.includes('DEPLOY_SSH_KEY')) ?? '';
    assert.match(prepare, /umask 077/);
    assert.match(prepare, /\$RUNNER_TEMP\/deploy_key/);
    const cleanup = /- name: Apagar a chave\n\s+if: always\(\)\n\s+run: (.+)/.exec(code)?.[1] ?? '';
    assert.match(cleanup, /rm -f "\$RUNNER_TEMP\/deploy_key"/);
    assert.match(cleanup, /deploy_known_hosts/);
  });

  it('o disparo manual (workflow_dispatch) só faz o dry-run (D17)', () => {
    const plan = runBlocks().find((run) => run.includes('EVENT_NAME == workflow_dispatch')) ?? '';
    assert.match(
      plan,
      /if \[\[ \$EVENT_NAME == workflow_dispatch \]\]; then\n\s+sha=\$INPUT_SHA\n\s+mode=dry-run\n/,
    );
    // Valores do evento chegam por env do job.
    assert.match(code, /RUN_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    assert.match(code, /INPUT_SHA: \$\{\{ inputs\.sha \}\}/);
  });

  it('o resumo explica os códigos de saída, inclusive o do programa de entrada e o do SSH', () => {
    const ssh = runBlocks().find((run) => /^\s*ssh /m.test(run)) ?? '';
    for (const exitCode of ['0)', '1)', '2)', '3)', '64)', '255)', '*)']) {
      assert.ok(ssh.includes(`${exitCode} meaning=`), `resumo sem o código ${exitCode}`);
    }
    assert.match(ssh, /GITHUB_STEP_SUMMARY/);
    assert.match(ssh, /exit "\$rc"/);
  });
});
