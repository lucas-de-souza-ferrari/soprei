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
