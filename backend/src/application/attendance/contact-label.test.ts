import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompanyId } from '../../domain/index.js';
import { describeContact } from './contact-label.js';

const A = CompanyId.parse('018f0000-0000-7000-8000-00000000000a');
const B = CompanyId.parse('018f0000-0000-7000-8000-00000000000b');

describe('describeContact (spec 024)', () => {
  it('telefone vira "Contato final" com os 4 últimos dígitos, em qualquer formatação', () => {
    for (const ref of ['5511999991234', '+55 (11) 99999-1234', '11999991234', '12345678']) {
      const described = describeContact(A, ref);
      assert.equal(described.contactLabel, `Contato final ${ref.replace(/\D/gu, '').slice(-4)}`);
      assert.equal(described.channel, 'whatsapp');
    }
    assert.equal(describeContact(A, '5511999991234').contactLabel, 'Contato final 1234');
    assert.equal(describeContact(A, '+55 (11) 99999-1234').contactLabel, 'Contato final 1234');
  });

  it('o rótulo de telefone não contém os demais dígitos', () => {
    const { contactLabel } = describeContact(A, '5511999991234');
    assert.equal(contactLabel.includes('551199999'), false);
    assert.equal(contactLabel.includes('5511999991234'), false);
  });

  it('o contato do teste do site vira "Teste no site" (simulador)', () => {
    assert.deepEqual(describeContact(A, 'teste-no-site'), {
      contactLabel: 'Teste no site',
      channel: 'simulator',
    });
  });

  it('texto livre vira "Simulador" com 4 hexadecimais estáveis e nunca aparece', () => {
    const first = describeContact(A, 'contato-maria-segredo');
    assert.match(first.contactLabel, /^Simulador [0-9a-f]{4}$/u);
    assert.equal(first.channel, 'simulator');
    assert.equal(first.contactLabel.includes('maria'), false);
    assert.deepEqual(describeContact(A, 'contato-maria-segredo'), first);
  });

  it('o hash inclui a empresa: o mesmo texto em empresas diferentes tem rótulos independentes', () => {
    const labels = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const ref = `ref-${String(index)}`;
      labels.add(`${describeContact(A, ref).contactLabel}|${describeContact(B, ref).contactLabel}`);
    }
    // Se o hash ignorasse a empresa, os dois lados seriam sempre iguais.
    assert.ok([...labels].some((pair) => pair.split('|')[0] !== pair.split('|')[1]));
  });

  it('bordas: 7 e 16 dígitos viram simulador; 8 e 15 viram telefone', () => {
    assert.match(describeContact(A, '1234567').contactLabel, /^Simulador /u);
    assert.equal(describeContact(A, '1234567').channel, 'simulator');
    assert.match(describeContact(A, '1234567890123456').contactLabel, /^Simulador /u);
    assert.equal(describeContact(A, '12345678').channel, 'whatsapp');
    assert.equal(describeContact(A, '123456789012345').channel, 'whatsapp');
  });

  it('texto com letras ou outros símbolos entre dígitos não é telefone', () => {
    for (const ref of ['5511999991234x', 'tel-5511999991234', '55.11.99999.1234', '']) {
      assert.equal(describeContact(A, ref).channel, 'simulator');
      assert.match(describeContact(A, ref).contactLabel, /^Simulador [0-9a-f]{4}$/u);
    }
  });
});
