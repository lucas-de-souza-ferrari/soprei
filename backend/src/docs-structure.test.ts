import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Gate da documentação (spec 042): o `AGENTS.md` é lido inteiro em toda sessão de agente e já chegou
// a 180 KB. Este teste lê os arquivos versionados como texto e falha se o núcleo voltar a inchar, se
// um arquivo de área ficar fora da lista "Áreas" (ninguém saberia que precisa lê-lo) ou se os
// roteiros deixarem de mandar ler a área tocada. Não confere o conteúdo das regras.
const REPO_ROOT = join(process.cwd(), '..');
const raw = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
const read = (path: string): string => raw(path).replaceAll('\r\n', '\n');

function tracked(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '');
}

const AGENTS_MAX_BYTES = 50_000;
const AREA_MAX_BYTES = 60_000;
// Montado por código: um agente já gravou o caractere literal ao escrever o escape num arquivo.
const BOM = String.fromCharCode(0xfeff);

const agents = read('AGENTS.md');
const areaFiles = tracked('docs/areas').filter((path) => path.endsWith('.md'));

describe('estrutura da documentação dos agentes (spec 042)', () => {
  it('o AGENTS.md fica abaixo do teto de tamanho', () => {
    const size = Buffer.byteLength(raw('AGENTS.md'));
    assert.ok(
      size <= AGENTS_MAX_BYTES,
      `AGENTS.md tem ${String(size)} bytes (teto ${String(AGENTS_MAX_BYTES)}): mova a área para docs/areas/`,
    );
  });

  it('a lista "Áreas" do AGENTS.md tem um item completo para cada arquivo de docs/areas', () => {
    const start = agents.indexOf('\n## Áreas');
    assert.ok(start >= 0, 'o AGENTS.md tem a seção "Áreas"');
    const section = agents.slice(start, agents.indexOf('\n## ', start + 1));
    const items = section.split('\n').filter((line) => line.startsWith('- [docs/areas/'));
    const listed = items.map((line) => {
      const item =
        /^- \[(docs\/areas\/[a-z0-9-]+\.md)\]\(([^)]+)\) — \*\*Seções:\*\* (.+?)\. \*\*Leia antes de tocar em:\*\* (.+)\.$/.exec(
          line,
        );
      assert.ok(item, `item fora do formato (arquivo, seções e gatilhos): ${line.slice(0, 80)}`);
      assert.equal(item[1], item[2], 'o texto do link é o próprio caminho');
      assert.match(item[3] ?? '', /\(\d{3}/, `${item[1] ?? ''}: as seções citam o número da spec`);
      assert.ok((item[4] ?? '').trim().length >= 10, `${item[1] ?? ''}: sem gatilho de leitura`);
      return item[1] ?? '';
    });
    assert.ok(areaFiles.length >= 1, 'docs/areas tem arquivos de área');
    assert.deepEqual([...listed].sort(), [...areaFiles].sort());
    assert.equal(new Set(listed).size, listed.length, 'nenhuma área repetida na lista');
  });

  it('nenhum arquivo de área passa do teto e todos têm o cabeçalho', () => {
    for (const path of areaFiles) {
      const size = Buffer.byteLength(raw(path));
      assert.ok(size <= AREA_MAX_BYTES, `${path} tem ${String(size)} bytes: divida a área`);
      assert.match(
        read(path),
        /^# .+\n\n> Parte das instruções do projeto/,
        `${path} sem o cabeçalho`,
      );
    }
  });

  it('nenhum arquivo de documentação começa com BOM', () => {
    const docs = tracked('AGENTS.md', 'CLAUDE.md', 'README.md', 'docs', '.claude/agents').filter(
      (path) => path.endsWith('.md'),
    );
    assert.ok(docs.length >= 50, 'a varredura enxerga a documentação versionada');
    for (const path of docs) assert.ok(!raw(path).startsWith(BOM), `${path} começa com BOM`);
  });

  it('os três roteiros mandam ler a área tocada', () => {
    for (const role of ['spec-writer', 'implementer', 'reviewer']) {
      assert.match(read(`docs/agents/${role}.md`), /docs\/areas\//, `roteiro ${role}`);
    }
  });
});

const HANDOFF_MAX_BYTES = 20_000;
const HANDOFF_SECTIONS = [
  'Última sessão',
  'Onde estamos',
  'Passos do dono pendentes',
  'Próximo passo',
  'Decisões do dono que não são óbvias no código',
  'Armadilhas',
  'O que não vem pelo git',
  'Pendências abertas',
];
const STATUS_LINE =
  /^- \*\*Status:\*\* (esboço|rascunho|aprovada|em implementação|concluída)(?=[ (.;,]|$)/m;
const specFiles = tracked('docs/specs').filter((path) => /^docs\/specs\/\d{3}-.+\.md$/.test(path));

describe('passagem de turno, specs e sobras (spec 042)', () => {
  it('o handoff guarda só o estado atual: teto de tamanho e seções fixas, nesta ordem', () => {
    const handoff = read('docs/handoff.md');
    const size = Buffer.byteLength(handoff);
    assert.ok(
      size <= HANDOFF_MAX_BYTES,
      `docs/handoff.md tem ${String(size)} bytes (teto ${String(HANDOFF_MAX_BYTES)}): substitua "Última sessão" em vez de empilhar`,
    );
    assert.ok(!handoff.startsWith(BOM), 'docs/handoff.md começa com BOM');
    const titles = [...handoff.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(titles, HANDOFF_SECTIONS);
  });

  it('a linha de status de toda spec começa por uma das cinco palavras do modelo', () => {
    assert.ok(specFiles.length >= 41, 'docs/specs tem as specs');
    for (const path of specFiles) {
      assert.match(read(path), STATUS_LINE, `${path}: status fora do vocabulário`);
    }
  });

  it('o índice docs/specs/README.md tem uma linha por spec, com o status da própria spec', () => {
    const index = read('docs/specs/README.md');
    const rows = new Map(
      [...index.matchAll(/^\| \[\d{3}\]\(([^)]+)\) \| .* \| ([^|]+) \| [^|]* \|$/gm)].map(
        (match) => [`docs/specs/${match[1] ?? ''}`, (match[2] ?? '').trim()],
      ),
    );
    assert.deepEqual([...rows.keys()].sort(), [...specFiles].sort());
    for (const path of specFiles) {
      const status = STATUS_LINE.exec(read(path))?.[1];
      assert.equal(rows.get(path), status, `${path}: o índice diz outro status`);
    }
  });

  it('as sobras removidas não voltam a ser versionadas', () => {
    assert.deepEqual(tracked('.tmp-onb.txt', 'lab'), []);
  });

  it('todo link relativo do README aponta para algo versionado', () => {
    const readme = read('README.md');
    const everything = tracked();
    const links = [...readme.matchAll(/\]\(([^)#]+)\)/g)]
      .map((match) => match[1] ?? '')
      .filter((target) => !/^[a-z]+:/.test(target));
    assert.ok(links.length >= 5, 'o README aponta para a documentação');
    for (const target of links) {
      const found = target.endsWith('/')
        ? everything.some((path) => path.startsWith(target))
        : everything.includes(target);
      assert.ok(found, `README.md aponta para ${target}, que não existe`);
    }
  });
});
