import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Spec 044, E3: o admin não guarda nada no navegador (D7). O lint recusa `localStorage` e
 * `sessionStorage` no código do app; os testes do Playwright os leem só para provar que estão vazios.
 */
const noBrowserStorage = [
  { name: 'localStorage', message: 'O admin não guarda nada no navegador (spec 044, E3).' },
  { name: 'sessionStorage', message: 'O admin não guarda nada no navegador (spec 044, E3).' },
];

export default [
  { ignores: ['dist/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { files: ['src/**'], rules: { 'no-restricted-globals': ['error', ...noBrowserStorage] } },
];
