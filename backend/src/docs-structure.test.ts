import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Gate da documentação (spec 042): o `AGENTS.md` é lido inteiro em toda sessão de agente e já chegou
// a 180 KB. Este teste lê os arquivos versionados como texto e falha se o núcleo voltar a inchar, se
// um arquivo de área ficar fora da tabela "Áreas" (ninguém saberia que precisa lê-lo) ou se os
// roteiros deixarem de mandar ler a área tocada. Não confere o conteúdo das regras.
const REPO_ROOT = join(process.cwd(), '..');
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
const bytes = (path: string): number => Buffer.byteLength(read(path));

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
const BOM = '﻿';

const agents = read('AGENTS.md');
const areaFiles = tracked('docs/areas').filter((path) => path.endsWith('.md'));

describe('estrutura da documentação dos agentes (spec 042)', () => {
  it('o AGENTS.md fica abaixo do teto de tamanho', () => {
    const size = bytes('AGENTS.md');
    assert.ok(
      size <= AGENTS_MAX_BYTES,
      `AGENTS.md tem ${String(size)} bytes (teto ${String(AGENTS_MAX_BYTES)}): mova a área para docs/areas/`,
    );
  });

  it('a tabela "Áreas" do AGENTS.md lista exatamente os arquivos de docs/areas', () => {
    const section = agents.slice(agents.indexOf('\n## Áreas'));
    const table = section.slice(0, section.indexOf('\n## ', 1));
    const listed = [...table.matchAll(/\]\((docs\/areas\/[a-z0-9-]+\.md)\)/g)].map(
      (match) => match[1],
    );
    assert.ok(areaFiles.length >= 10, 'docs/areas tem os arquivos de área');
    assert.deepEqual([...listed].sort(), [...areaFiles].sort());
    assert.equal(new Set(listed).size, listed.length, 'nenhuma área repetida na tabela');
  });

  it('nenhum arquivo de área passa do teto nem começa com BOM', () => {
    for (const path of [...areaFiles, 'AGENTS.md']) {
      const text = read(path);
      assert.ok(!text.startsWith(BOM), `${path} começa com BOM`);
      if (path === 'AGENTS.md') continue;
      const size = Buffer.byteLength(text);
      assert.ok(size <= AREA_MAX_BYTES, `${path} tem ${String(size)} bytes: divida a área`);
      assert.match(text, /^# .+\n\n> Parte das instruções do projeto/, `${path} sem o cabeçalho`);
    }
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
