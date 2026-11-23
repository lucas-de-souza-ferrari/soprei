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
