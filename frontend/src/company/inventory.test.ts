import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pageForPath, pathForPage } from '../account-flow';
import { ApiError } from '../api';
import { allowedPages, AREA_PAGES, areaPageForPath, canOpen } from './company-nav';
import {
  INSUFFICIENT_STOCK_MESSAGE,
  INVENTORY_INVALID_MESSAGE,
  INVENTORY_LIMIT_MESSAGE,
  inventoryMessageOf,
  productSchema,
  SKU_IN_USE_MESSAGE,
  STOCK_LIMIT_MESSAGE,
} from './inventory-api';
import { ADJUST_KINDS, deltaFor, productFormProblem, stockStatus } from './inventory-rules';
import { formatMoney, moneyInputValue, parseMoney } from './money';

test('a aba Estoque fica depois de Conhecimento e só abre com inventory:manage', () => {
  const order = [...AREA_PAGES];
  assert.ok(order.indexOf('conhecimento') < order.indexOf('estoque'));
  assert.ok(order.indexOf('estoque') < order.indexOf('equipe'));
  assert.equal(areaPageForPath('/painel/estoque'), 'estoque');
  assert.equal(pageForPath('/painel/estoque'), 'estoque');
  assert.equal(pathForPage('estoque'), '/painel/estoque');
  assert.equal(canOpen('estoque', ['inventory:manage']), true);
  assert.equal(canOpen('estoque', ['knowledge:manage']), false);
  assert.ok(allowedPages(['conversation:read', 'inventory:manage']).includes('estoque'));
  assert.ok(!allowedPages(['conversation:read', 'conversation:simulate']).includes('estoque'));
});

test('preço: "59,90", "1.234,50", "59", "59.90" viram centavos; entrada inválida é recusada', () => {
  assert.equal(parseMoney('59,90'), 5990);
  assert.equal(parseMoney('1.234,50'), 123450);
  assert.equal(parseMoney('59'), 5900);
  assert.equal(parseMoney('59.90'), 5990);
  assert.equal(parseMoney('R$ 59,9'), 5990);
  assert.equal(parseMoney('0,05'), 5);
  assert.equal(parseMoney('1.000'), 100000);
  assert.equal(parseMoney('1.000.000,00'), 100_000_000);
  for (const bad of [
    '',
    'abc',
    '-5',
    '59,999',
    '1,2,3',
    '1.2.3',
    '5,',
    ',5',
    '1.000.000,01',
    '99999999999',
  ]) {
    assert.equal(parseMoney(bad), null, bad);
  }
});

test('formatação de volta: R$ com vírgula e campo de edição', () => {
  assert.equal(formatMoney(5990), 'R$ 59,90');
  assert.equal(formatMoney(123450), 'R$ 1.234,50');
  assert.equal(moneyInputValue(5990), '59,90');
  assert.equal(parseMoney(moneyInputValue(123450)), 123450);
});

test('estoque baixo e sem estoque: regra e rótulo de texto', () => {
  assert.equal(stockStatus(0, 5), 'out');
  assert.equal(stockStatus(0, 0), 'out');
  assert.equal(stockStatus(5, 5), 'low');
  assert.equal(stockStatus(3, 5), 'low');
  assert.equal(stockStatus(6, 5), 'ok');
  assert.equal(stockStatus(1, 0), 'ok');
});

test('ajuste: entrada soma, saída e perda subtraem, correção aceita sinal; zero e lixo são recusados', () => {
  assert.equal(deltaFor('ENTRY', '5'), 5);
  assert.equal(deltaFor('EXIT', '5'), -5);
  assert.equal(deltaFor('LOSS', ' 2 '), -2);
  assert.equal(deltaFor('COUNT_CORRECTION', '-3'), -3);
  assert.equal(deltaFor('COUNT_CORRECTION', '+4'), 4);
  assert.equal(deltaFor('ENTRY', '-5'), null);
  assert.equal(deltaFor('ENTRY', '0'), null);
  assert.equal(deltaFor('ENTRY', '1,5'), null);
  assert.equal(deltaFor('ENTRY', '100001'), null);
  assert.equal(deltaFor('EXIT', ''), null);
  assert.deepEqual([...ADJUST_KINDS], ['ENTRY', 'EXIT', 'LOSS', 'COUNT_CORRECTION']);
});

test('formulário de produto: SKU, nome, preço e quantidade', () => {
  const ok = {
    sku: 'cam-001',
    name: 'Camiseta',
    description: '',
    price: '59,90',
    quantity: '3',
    threshold: '',
  };
  assert.equal(productFormProblem(ok, true), null);
  assert.notEqual(productFormProblem({ ...ok, sku: 'com espaço' }, true), null);
  assert.notEqual(productFormProblem({ ...ok, name: '  ' }, true), null);
  assert.notEqual(productFormProblem({ ...ok, price: 'x' }, true), null);
  assert.notEqual(productFormProblem({ ...ok, quantity: '-1' }, true), null);
  assert.equal(productFormProblem({ ...ok, sku: '', quantity: '' }, false), null);
});

test('mensagens por code: SKU repetido, estoque insuficiente, limites e 400; o texto do servidor nunca é lido', () => {
  const failure = (status: number, code: string | undefined) =>
    inventoryMessageOf(new ApiError(status, 'TEXTO-DO-SERVIDOR', code));
  assert.equal(failure(409, 'SKU_IN_USE'), SKU_IN_USE_MESSAGE);
  assert.equal(failure(409, 'INSUFFICIENT_STOCK'), INSUFFICIENT_STOCK_MESSAGE);
  assert.equal(failure(409, 'STOCK_LIMIT'), STOCK_LIMIT_MESSAGE);
  assert.equal(failure(409, 'INVENTORY_LIMIT_REACHED'), INVENTORY_LIMIT_MESSAGE);
  assert.equal(failure(400, 'VALIDATION_ERROR'), INVENTORY_INVALID_MESSAGE);
  assert.equal(failure(403, 'FORBIDDEN'), null);
  for (const message of [SKU_IN_USE_MESSAGE, INSUFFICIENT_STOCK_MESSAGE]) {
    assert.ok(!message.includes('TEXTO-DO-SERVIDOR'));
  }
});

test('contrato estrito do produto: campo desconhecido é recusado', () => {
  const base = {
    id: '0190a8b0-7c1e-7000-8000-000000000001',
    sku: 'CAM-001',
    name: 'Camiseta',
    description: '',
    priceCents: 5990,
    quantity: 3,
    lowStockThreshold: 0,
    active: true,
    isSample: false,
    updatedAt: '2026-11-04T12:00:00.000Z',
  };
  assert.ok(productSchema.safeParse(base).success);
  assert.ok(!productSchema.safeParse({ ...base, searchText: 'x' }).success);
});

test('o front não grava produto nem preço em localStorage/sessionStorage/console', () => {
  for (const file of ['EstoquePage.tsx', 'inventory-api.ts', 'inventory-rules.ts', 'money.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|console\.|history\.(push|replace)State/,
    );
  }
});
