import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Spec 041: os leitores de PDF e DOCX interpretam arquivo não confiável e só podem ser alcançados por
 * `import()`/`new Worker`. O `pdfjs-dist` só entra em `pdf-text.ts`; o `mammoth`, só no worker do DOCX.
 */
const PDF_MODULE = 'src/company/pdf-text.ts';
const DOCX_WORKER = 'src/company/docx-text.worker.ts';
const pdfRestriction = {
  group: ['pdfjs-dist', 'pdfjs-dist/*'],
  message: 'O pdfjs-dist só é importado em src/company/pdf-text.ts (spec 041).',
};
const docxRestriction = {
  group: ['mammoth', 'mammoth/*'],
  message: 'O mammoth só é importado em src/company/docx-text.worker.ts (spec 041).',
};

export default [
  { ignores: ['dist/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    ignores: [PDF_MODULE, DOCX_WORKER],
    rules: {
      'no-restricted-imports': ['error', { patterns: [pdfRestriction, docxRestriction] }],
    },
  },
  {
    files: [PDF_MODULE],
    rules: { 'no-restricted-imports': ['error', { patterns: [docxRestriction] }] },
  },
  {
    files: [DOCX_WORKER],
    rules: { 'no-restricted-imports': ['error', { patterns: [pdfRestriction] }] },
  },
];
