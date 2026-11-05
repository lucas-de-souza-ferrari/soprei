import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pickCompanyToOpen } from './company-pick';

const a = { companyId: 'a' };
const b = { companyId: 'b' };

test('spec 029 E2: seleção válida da sessão abre direto', () => {
  assert.deepEqual(pickCompanyToOpen([a, b], 'b'), { kind: 'open', companyId: 'b' });
  assert.deepEqual(pickCompanyToOpen([a], 'a'), { kind: 'open', companyId: 'a' });
});

test('spec 029 E2: uma só empresa e nenhuma selecionada: seleciona e abre', () => {
  assert.deepEqual(pickCompanyToOpen([a], null), { kind: 'select', companyId: 'a' });
  // Seleção que não está mais na lista (empresa suspensa, vínculo desativado) conta como nenhuma.
  assert.deepEqual(pickCompanyToOpen([a], 'sumiu'), { kind: 'select', companyId: 'a' });
});

test('spec 029 E2: várias e nenhuma selecionada: tela de empresas', () => {
  assert.deepEqual(pickCompanyToOpen([a, b], null), { kind: 'choose' });
  assert.deepEqual(pickCompanyToOpen([a, b], 'sumiu'), { kind: 'choose' });
});

test('spec 029 E2: nenhuma empresa: criar a primeira', () => {
  assert.deepEqual(pickCompanyToOpen([], null), { kind: 'create' });
  assert.deepEqual(pickCompanyToOpen([], 'sumiu'), { kind: 'create' });
});
