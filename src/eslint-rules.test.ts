import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

/**
 * Prova a terceira barreira de isolamento: roda o ESLint **de verdade**, com o
 * `eslint.config.js` do projeto, sobre trechos de código "fixture" em caminhos virtuais
 * (nada é escrito em disco) e confere que o acesso ao Prisma e o SQL cru fora de
 * `src/infrastructure/database/**` são erros, e que dentro dessa pasta são permitidos.
 * As regras de tipo são desligadas só aqui: os caminhos virtuais não pertencem ao projeto
 * do TypeScript e as regras sob teste (`no-restricted-*`) não precisam de tipos.
 */
const eslint = new ESLint({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  overrideConfigFile: fileURLToPath(new URL('../eslint.config.js', import.meta.url)),
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { projectService: false } } },
  ],
});

async function restrictedRules(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result, 'o ESLint não devolveu resultado');
  const fatal = result.messages.filter((message) => message.fatal);
  assert.deepEqual(
    fatal.map((message) => message.message),
    [],
  );
  return result.messages
    .map((message) => message.ruleId)
    .filter((ruleId) => ruleId === 'no-restricted-imports' || ruleId === 'no-restricted-syntax')
    .map(String)
    .filter((ruleId, index, all) => all.indexOf(ruleId) === index);
}

const OUTSIDE = [
  'src/presentation/fixture.ts',
  'src/application/fixture.ts',
  'src/infrastructure/http/fixture.ts',
  'src/shared/fixture.ts',
  'src/index.ts',
];
const INSIDE = ['src/infrastructure/database/fixture.ts', 'src/infrastructure/database/x/y.ts'];

describe('lint: importar o Prisma fora de src/infrastructure/database', () => {
  const imports = [
    "import { PrismaClient } from '../generated/prisma/client.js';",
    "import { Prisma } from '../../generated/prisma/client.js';",
    "import type { Client } from '../../generated/prisma/models.js';",
    "import { PrismaClient } from '@prisma/client';",
    "import { PrismaPg } from '@prisma/adapter-pg';",
    "import pg from 'pg';",
    "import { getPrisma } from '../infrastructure/database/index.js';",
    "import { getPrisma } from '../database/index.js';",
    "import { PrismaClient } from '../infrastructure/database/database.js';",
  ];

  for (const filePath of OUTSIDE) {
    for (const code of imports) {
      it(`${filePath}: ${code}`, async () => {
        assert.deepEqual(await restrictedRules(`${code}\nexport {};\n`, filePath), [
          'no-restricted-imports',
        ]);
      });
    }
  }

  it('dentro de src/infrastructure/database/** o acesso ao Prisma é permitido', async () => {
    for (const filePath of INSIDE) {
      for (const code of imports) {
        assert.deepEqual(await restrictedRules(`${code}\nexport {};\n`, filePath), [], code);
      }
    }
  });

  it('importar outras coisas do módulo de banco (getDatabase, tipos) segue permitido no resto do src', async () => {
    const code =
      "import { getDatabase, type Database } from './infrastructure/database/index.js';\nexport { getDatabase };\nexport type { Database };\n";
    assert.deepEqual(await restrictedRules(code, 'src/index.ts'), []);
    assert.deepEqual(await restrictedRules(code, 'src/infrastructure/lifecycle.ts'), []);
  });

  it('application e presentation não importam nada da pasta de banco', async () => {
    const code =
      "import { getDatabase } from '../infrastructure/database/index.js';\nexport { getDatabase };\n";
    for (const filePath of ['src/application/fixture.ts', 'src/presentation/fixture.ts']) {
      assert.deepEqual(await restrictedRules(code, filePath), ['no-restricted-imports']);
    }
  });

  it('domain não importa de infrastructure, application, presentation nem Fastify', async () => {
    for (const code of [
      "import { x } from '../infrastructure/config/index.js';",
      "import { x } from '../application/client.service.js';",
      "import { x } from '../presentation/health.controller.js';",
      "import Fastify from 'fastify';",
    ]) {
      assert.deepEqual(await restrictedRules(`${code}\nexport {};\n`, 'src/domain/fixture.ts'), [
        'no-restricted-imports',
      ]);
    }
    assert.deepEqual(
      await restrictedRules(
        "import { x } from '../shared/errors/index.js';\nexport { x };\n",
        'src/domain/fixture.ts',
      ),
      [],
    );
  });
});

describe('lint: SQL cru fora de src/infrastructure/database', () => {
  const snippets = [
    'declare const db: { $queryRaw: unknown };\nexport const a = db.$queryRaw;',
    'declare const db: { $queryRaw(s: TemplateStringsArray): unknown };\nexport const a = db.$queryRaw`SELECT 1`;',
    "declare const db: { $queryRawUnsafe(s: string): unknown };\nexport const a = db.$queryRawUnsafe('SELECT 1');",
    "declare const db: { $executeRaw(s: string): unknown };\nexport const a = db.$executeRaw('x');",
    "declare const db: { $executeRawUnsafe(s: string): unknown };\nexport const a = db.$executeRawUnsafe('x');",
    "declare const db: Record<string, unknown>;\nexport const a = db['$queryRaw'];",
    'declare const db: { $queryRaw: unknown };\nexport const { $queryRaw } = db;',
    'declare const db: { $queryRaw: unknown };\nexport const a = db?.$queryRaw;',
  ];

  for (const filePath of OUTSIDE) {
    for (const code of snippets) {
      it(`${filePath}: ${code.split('\n')[1] ?? ''}`, async () => {
        const rules = await restrictedRules(`${code}\n`, filePath);
        assert.ok(rules.includes('no-restricted-syntax'), `deveria falhar: ${code}`);
      });
    }
  }

  it('dentro de src/infrastructure/database/** o SQL cru é permitido (ex.: health check)', async () => {
    for (const filePath of INSIDE) {
      for (const code of snippets) {
        assert.deepEqual(await restrictedRules(`${code}\n`, filePath), [], code);
      }
    }
  });

  it('nomes parecidos não são pegos à toa', async () => {
    const code =
      'declare const db: { queryRaw: unknown; $query: unknown };\nexport const a = [db.queryRaw, db.$query];\n';
    assert.deepEqual(await restrictedRules(code, 'src/presentation/fixture.ts'), []);
  });
});

describe('lint: o código real do projeto', () => {
  it('o próprio health check (src/infrastructure/database/database.ts) é a exceção documentada', async () => {
    const code =
      'declare const prisma: { $queryRaw(s: TemplateStringsArray): unknown };\nexport const ping = prisma.$queryRaw`SELECT 1`;\n';
    assert.deepEqual(await restrictedRules(code, 'src/infrastructure/database/database.ts'), []);
  });
});
