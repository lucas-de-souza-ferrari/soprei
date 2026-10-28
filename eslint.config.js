import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Isolamento entre clientes, terceira barreira (spec 003): o acesso ao Prisma e o SQL cru
// ficam só em src/infrastructure/database/**. Application, presentation e domain enxergam
// interfaces do domínio, nunca o Prisma. Única exceção: a própria pasta database (inclui o
// health check, que roda `SELECT 1` em database.ts). O teste src/eslint-rules.test.ts prova
// que estas regras pegam o que devem.
const PRISMA_MESSAGE =
  'Acesso ao Prisma só em src/infrastructure/database/**. Use as interfaces de repositório do domínio.';

const PRISMA_IMPORT_PATTERNS = [
  { group: ['**/generated/prisma', '**/generated/prisma/**'], message: PRISMA_MESSAGE },
  {
    group: ['@prisma/client', '@prisma/client/**', '@prisma/adapter-pg', 'pg'],
    message: PRISMA_MESSAGE,
  },
  {
    group: ['**/infrastructure/database', '**/infrastructure/database/**', '**/database/*.js'],
    importNames: ['getPrisma', 'PrismaClient'],
    message: PRISMA_MESSAGE,
  },
];

const DATABASE_FOLDER_PATTERN = {
  group: ['**/infrastructure/database', '**/infrastructure/database/**'],
  message:
    'Application, presentation e domain não importam a camada de banco; dependa de interfaces do domínio e receba a implementação por injeção.',
};

// Fila e Redis são detalhes de infraestrutura (spec 011): application e presentation conhecem só as
// portas (`InboundJobQueue`...), nunca o BullMQ nem o ioredis.
const QUEUE_REDIS_PATTERN = {
  group: ['bullmq', 'bullmq/**', 'ioredis', 'ioredis/**'],
  message:
    'BullMQ e ioredis só em src/infrastructure/**. Application e presentation dependem das portas (src/application/ports/), recebidas por injeção.',
};

const DOMAIN_PATTERNS = [
  {
    group: [
      '**/infrastructure',
      '**/infrastructure/**',
      '**/application',
      '**/application/**',
      '**/presentation',
      '**/presentation/**',
      'fastify',
      'fastify/**',
    ],
    message: 'domain não importa de nenhuma outra camada (só de shared) nem de Fastify.',
  },
];

const RAW_SQL_NAME = String.raw`^\$(query|execute)Raw(Unsafe|Typed)?$`;
const RAW_SQL_MESSAGE =
  'SQL cru só em src/infrastructure/database/**: ele não passa pelo filtro de cliente. Use o repositório do domínio.';

const RAW_SQL_SELECTORS = [
  { selector: `MemberExpression[property.name=/${RAW_SQL_NAME}/]`, message: RAW_SQL_MESSAGE },
  { selector: `MemberExpression[property.value=/${RAW_SQL_NAME}/]`, message: RAW_SQL_MESSAGE },
  { selector: `Property[key.name=/${RAW_SQL_NAME}/]`, message: RAW_SQL_MESSAGE },
  { selector: `Property[key.value=/${RAW_SQL_NAME}/]`, message: RAW_SQL_MESSAGE },
];

export default defineConfig(
  { ignores: ['dist/', 'node_modules/', 'src/generated/'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', minimumDescriptionLength: 10 },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // describe/it/before/after do node:test devolvem Promise que o próprio runner aguarda;
    // exigir await/void em cada um seria ruído. Fora dos testes a regra segue ativa.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/infrastructure/database/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: PRISMA_IMPORT_PATTERNS }],
      'no-restricted-syntax': ['error', ...RAW_SQL_SELECTORS],
    },
  },
  {
    files: ['src/application/**/*.ts', 'src/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...PRISMA_IMPORT_PATTERNS, DATABASE_FOLDER_PATTERN, QUEUE_REDIS_PATTERN] },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...PRISMA_IMPORT_PATTERNS, DATABASE_FOLDER_PATTERN, ...DOMAIN_PATTERNS] },
      ],
    },
  },
  eslintConfigPrettier,
);
