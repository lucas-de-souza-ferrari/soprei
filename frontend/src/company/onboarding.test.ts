import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedPages, areaPageForPath, areaPath, canOpen } from './company-nav';
import {
  checklistCounts,
  checklistItems,
  firstPending,
  type OnboardingState,
  PERSONA_TEMPLATE,
  resolveStep,
  showChecklist,
  visibleSteps,
  WIZARD_PATH,
  wizardPath,
  wizardStepForPath,
} from './onboarding-steps';

const ALL = ['onboarding:manage', 'conversation:simulate', 'conversation:read'] as const;
const full = (steps: OnboardingState['steps'], dismissed = false): OnboardingState => ({
  dismissed,
  steps,
});
const EMPTY = full({ persona: false, knowledge: false, schedule: false, inventory: false });

describe('passos visíveis e primeiro pendente (spec 030)', () => {
  it('seis passos na ordem, o 1 sempre feito e numerados de 1 a 6', () => {
    const steps = visibleSteps(EMPTY, ALL);
    assert.deepEqual(
      steps.map((step) => [step.number, step.id, step.done, step.optional]),
      [
        [1, 'empresa', true, false],
        [2, 'persona', false, false],
        [3, 'documentos', false, false],
        [4, 'servicos', false, true],
        [5, 'estoque', false, true],
        [6, 'testar', false, false],
      ],
    );
    assert.equal(firstPending(steps), 'persona');
  });

  it('passo ausente na resposta é oculto e a contagem acompanha', () => {
    const steps = visibleSteps(full({ persona: true, knowledge: false }), ALL);
    assert.deepEqual(
      steps.map((step) => step.id),
      ['empresa', 'persona', 'documentos', 'testar'],
    );
    assert.equal(steps.at(-1)?.number, 4);
    assert.equal(firstPending(steps), 'documentos');
  });

  it('sem permissão de simulador, o passo de testar some', () => {
    const steps = visibleSteps(EMPTY, ['onboarding:manage']);
    assert.equal(
      steps.some((step) => step.id === 'testar'),
      false,
    );
  });

  it('tudo feito: o primeiro pendente é o teste final (ou o último passo que existir)', () => {
    const done = full({ persona: true, knowledge: true, schedule: true, inventory: true });
    assert.equal(firstPending(visibleSteps(done, ALL)), 'testar');
    assert.equal(firstPending(visibleSteps(done, ['onboarding:manage'])), 'estoque');
    assert.equal(firstPending(visibleSteps(full({}), [])), null);
  });

  it('o primeiro pendente pula o que já está feito, inclusive opcionais feitos', () => {
    const state = full({ persona: true, knowledge: true, schedule: false, inventory: true });
    assert.equal(firstPending(visibleSteps(state, ALL)), 'servicos');
  });

  it('o passo da URL só vale se visível; fora do conjunto cai no primeiro pendente', () => {
    const steps = visibleSteps(full({ persona: true, knowledge: false }), ALL);
    assert.equal(resolveStep(steps, 'persona'), 'persona');
    assert.equal(resolveStep(steps, 'estoque'), 'documentos');
    assert.equal(resolveStep(steps, null), 'documentos');
  });
});

describe('endereços do assistente (spec 030)', () => {
  it('cinco passos mapeiam para o endereço e de volta', () => {
    for (const step of ['persona', 'documentos', 'servicos', 'estoque', 'testar'] as const) {
      assert.equal(wizardStepForPath(wizardPath(step)), step);
      assert.equal(areaPageForPath(wizardPath(step)), 'primeirosPassos');
    }
    assert.equal(wizardPath(), WIZARD_PATH);
    assert.equal(areaPath('primeirosPassos'), WIZARD_PATH);
    assert.equal(areaPageForPath(WIZARD_PATH), 'primeirosPassos');
  });

  it('qualquer outro sufixo é a tela, mas sem passo (cai no primeiro pendente)', () => {
    for (const path of [
      `${WIZARD_PATH}/`,
      `${WIZARD_PATH}/inexistente`,
      `${WIZARD_PATH}/persona/extra`,
      `${WIZARD_PATH}/PERSONA`,
      `${WIZARD_PATH}/%70ersona`,
    ]) {
      assert.equal(wizardStepForPath(path), null, path);
      assert.equal(areaPageForPath(path), 'primeirosPassos', path);
    }
    assert.equal(wizardStepForPath('/painel/conversas'), null);
    assert.equal(wizardStepForPath('/painel/primeiros-passosx/persona'), null);
  });
});

describe('menu e permissão (spec 030)', () => {
  it('primeirosPassos exige onboarding:manage', () => {
    assert.equal(canOpen('primeirosPassos', ['onboarding:manage']), true);
    for (const other of ['persona:manage', 'conversation:read', 'channel:manage']) {
      assert.equal(canOpen('primeirosPassos', [other]), false, other);
    }
    assert.deepEqual(allowedPages(['conversation:read', 'conversation:simulate']), [
      'conversas',
      'testar',
    ]);
    assert.ok(allowedPages(['conversation:read', 'onboarding:manage']).includes('primeirosPassos'));
  });
});

describe('lista "Configuração" (spec 030)', () => {
  it('conta feitos de quantos e marca opcionais', () => {
    const items = checklistItems(
      full({ persona: true, knowledge: false, schedule: false, inventory: false }),
    );
    assert.deepEqual(
      items.map((item) => [item.step, item.done, item.optional]),
      [
        ['persona', true, false],
        ['documentos', false, false],
        ['servicos', false, true],
        ['estoque', false, true],
      ],
    );
    assert.deepEqual(checklistCounts(items), { done: 1, total: 4 });
  });

  it('aparece só com permissão, sem dispensar e enquanto falta algo', () => {
    assert.equal(showChecklist(EMPTY, ['onboarding:manage']), true);
    assert.equal(showChecklist(EMPTY, ['conversation:read']), false);
    assert.equal(showChecklist(full(EMPTY.steps, true), ['onboarding:manage']), false);
    const done = full({ persona: true, knowledge: true, schedule: true, inventory: true });
    assert.equal(showChecklist(done, ['onboarding:manage']), false);
    assert.equal(showChecklist(full({}), ['onboarding:manage']), false);
    assert.equal(showChecklist(full({ persona: true }), ['onboarding:manage']), false);
    assert.equal(showChecklist(full({ persona: false }), ['onboarding:manage']), true);
  });
});

describe('modelo de persona (D12)', () => {
  it('é texto fixo, curto, com lacunas entre colchetes e cabe no limite', () => {
    assert.ok(PERSONA_TEMPLATE.length < 600);
    assert.match(PERSONA_TEMPLATE, /\[nome da empresa\]/);
  });
});
