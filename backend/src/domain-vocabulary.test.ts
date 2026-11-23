import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  findVocabularyLeftovers,
  MARKER_END,
  MARKER_START,
  type VocabularyAllowlist,
  type VocabularyFile,
} from './test-support/vocabulary-gate.js';

// Gate de restos (spec 022): `Client` virou `Company` e `User` virou `Membership` em todo lugar.
// Este teste falha se um identificador antigo voltar a aparecer fora da lista de exceções declarada
// (`domain-vocabulary.allowlist.json`, com o motivo de cada uma) e se uma exceção não casar mais com
// nada. As migrations anteriores à 022 e as specs 001 a 021 não são varridas (são histórico).
const REPO_ROOT = join(process.cwd(), '..');
const SCANNED = [
  'backend/src',
  'backend/prisma/schema.prisma',
  'backend/.env.example',
  'backend/.env.test.example',
  'frontend/src',
  'frontend/e2e',
  'AGENTS.md',
  'docs/context.md',
  'docs/handoff.md',
  'docs/agents',
  'docs/areas',
] as const;
const TEXT_FILE = /\.(ts|tsx|js|cjs|mjs|json|css|html|md|prisma|example)$/;

function trackedFiles(): VocabularyFile[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...SCANNED], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return listed
    .split('\0')
    .filter((path) => path !== '' && TEXT_FILE.test(path))
    .map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));
}

const allowlist = JSON.parse(
  readFileSync(new URL('./domain-vocabulary.allowlist.json', import.meta.url), 'utf8'),
) as VocabularyAllowlist;

describe('gate de restos do vocabulário antigo (spec 022)', () => {
  it('nenhum identificador antigo (Client/User do domínio) fora das exceções declaradas', () => {
    const files = trackedFiles();
    assert.ok(files.length > 200, 'a varredura enxerga a árvore versionada');
    const { violations, unused } = findVocabularyLeftovers(files, allowlist);
    const shown = violations
      .slice(0, 30)
      .map((v) => `${v.path}:${String(v.line)} (${v.pattern})`)
      .join('\n');
    assert.equal(violations.length, 0, `restos do vocabulário antigo:\n${shown}`);
    assert.deepEqual(unused, [], 'exceção que não casa mais com nada deve ser removida');
  });

  it('toda exceção tem um motivo e aponta para um arquivo versionado', () => {
    const tracked = new Set(trackedFiles().map((file) => file.path));
    for (const rule of allowlist.fileExceptions) {
      assert.ok(rule.reason.length >= 10, `motivo de ${rule.path}`);
      assert.ok(rule.patterns.length > 0);
      const found = [...tracked].some((path) =>
        rule.path.endsWith('/') ? path.startsWith(rule.path) : path === rule.path,
      );
      assert.ok(found, `${rule.path} não existe mais`);
    }
    for (const mask of allowlist.maskedTokens) assert.ok(mask.reason.length >= 10, mask.pattern);
  });

  it('o próprio gate falha com um arquivo que contém um nome antigo', () => {
    const empty: VocabularyAllowlist = { fileExceptions: [], maskedTokens: [] };
    for (const text of [
      'const clientId = 1;',
      'type Client = {};',
      'SELECT id FROM clients',
      'o cliente escreve',
      'POST /admin/clients',
      'const userId = 1;',
      'USER_CREATED',
      "headers: { 'X-Soprei-Client': 'web' }",
    ]) {
      const result = findVocabularyLeftovers([{ path: 'backend/src/exemplo.ts', text }], empty);
      assert.ok(result.violations.length > 0, text);
    }
    const clean = findVocabularyLeftovers(
      [
        {
          path: 'backend/src/exemplo.ts',
          text: 'const companyId = 1; // Membership e Company; MessageRole.USER e PrismaClient ficam',
        },
      ],
      empty,
    );
    assert.deepEqual(clean.violations, []);
  });

  it('exceção ou máscara que não casa com nada é recusada (a lista não apodrece)', () => {
    const stale: VocabularyAllowlist = {
      fileExceptions: [
        {
          path: 'backend/src/exemplo.ts',
          patterns: ['ClientId'],
          reason: 'nada mais usa isso aqui',
        },
      ],
      maskedTokens: [{ pattern: 'pg\\.Client', reason: 'cliente do driver pg, de terceiros' }],
    };
    const result = findVocabularyLeftovers(
      [{ path: 'backend/src/exemplo.ts', text: 'const companyId = 1;' }],
      stale,
    );
    assert.equal(result.unused.length, 2);
    const used = findVocabularyLeftovers(
      [{ path: 'backend/src/exemplo.ts', text: 'const clientId = new pg.Client();' }],
      stale,
    );
    assert.deepEqual(used.violations, []);
    assert.deepEqual(used.unused, []);
  });

  it('a região entre as marcas de documentação (tabela antigo -> novo, histórico) é ignorada só em .md', () => {
    const empty: VocabularyAllowlist = { fileExceptions: [], maskedTokens: [] };
    const text = `${MARKER_START}\nClient virou Company (clientId)\n${MARKER_END}\nfora\n`;
    assert.deepEqual(findVocabularyLeftovers([{ path: 'AGENTS.md', text }], empty).violations, []);
    assert.ok(
      findVocabularyLeftovers([{ path: 'backend/src/x.ts', text }], empty).violations.length > 0,
    );
  });
});
