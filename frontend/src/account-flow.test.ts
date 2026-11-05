import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ACCOUNT_PATHS,
  isNeutralResetRequestError,
  pageForPath,
  pathForPage,
  passwordProblem,
  PASSWORD_PROBLEM,
  RESET_NEUTRAL_MESSAGE,
  type AccountPage,
} from './account-flow';

test('navegação: cada página tem caminho próprio e o caminho abre a página certa', () => {
  const pages: AccountPage[] = ['login', 'register', 'verify', 'forgot', 'reset'];
  for (const page of pages) {
    assert.equal(pageForPath(pathForPage(page)), page);
    assert.ok(ACCOUNT_PATHS.includes(pathForPage(page)));
  }
  assert.equal(pathForPage('forgot'), '/recuperar-senha');
  assert.equal(pathForPage('reset'), '/redefinir-senha');
  assert.equal(pageForPath('/painel/empresas'), 'companies');
  assert.equal(pageForPath('/qualquer'), 'login');
});

test('senha nova: a mesma política do cadastro (6 caracteres, maiúscula e número, NFKC)', () => {
  for (const value of ['Abcde1', 'Árvore1', 'Ａbcde1']) {
    assert.equal(passwordProblem(value), null, value);
  }
  for (const value of ['Abc1', 'abcdef1', 'Abcdefg', `A1${'a'.repeat(127)}`]) {
    assert.equal(passwordProblem(value), PASSWORD_PROBLEM, value);
  }
  assert.equal(passwordProblem(`Abcde1${String.fromCharCode(0)}`), PASSWORD_PROBLEM);
});

test('pedido de código: 4xx (menos 429) vira mensagem neutra; 429 e erro de servidor não', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isNeutralResetRequestError(status), true, String(status));
  }
  for (const status of [429, 500, 502, 503]) {
    assert.equal(isNeutralResetRequestError(status), false, String(status));
  }
  assert.equal(
    RESET_NEUTRAL_MESSAGE,
    'Se existir uma conta, enviamos um código para o e-mail informado.',
  );
});
