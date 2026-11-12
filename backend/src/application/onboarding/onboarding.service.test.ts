import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompanyId, hasPermission, type Permission } from '../../domain/index.js';
import { InMemoryOnboardingStore } from '../../test-support/in-memory-onboarding.js';
import { OnboardingService } from './onboarding.service.js';

const A = CompanyId.parse('0197a000-0000-7000-8000-00000000000a');
const B = CompanyId.parse('0197a000-0000-7000-8000-00000000000b');
const everything = (): boolean => true;
const only =
  (...allowed: Permission[]) =>
  (permission: Permission): boolean =>
    allowed.includes(permission);

describe('OnboardingService (spec 030)', () => {
  it('empresa vazia: todos os passos false e não dispensado', async () => {
    const store = new InMemoryOnboardingStore();
    store.seed(A);
    const state = await new OnboardingService(store).get(A, everything);
    assert.deepEqual(state, {
      dismissed: false,
      steps: { persona: false, knowledge: false, schedule: false, inventory: false },
    });
  });

  it('passo sem permissão não existe na resposta nem é consultado', async () => {
    const store = new InMemoryOnboardingStore();
    store.seed(A, { persona: true, knowledge: true, schedule: true, inventory: true });
    const state = await new OnboardingService(store).get(
      A,
      only('persona:manage', 'knowledge:manage'),
    );
    assert.deepEqual(state.steps, { persona: true, knowledge: true });
    assert.equal('schedule' in state.steps, false);
    assert.equal('inventory' in state.steps, false);
    assert.deepEqual(store.reads.at(-1), {
      persona: true,
      knowledge: true,
      schedule: false,
      inventory: false,
    });
  });

  it('papéis reais: AGENT e VIEWER não têm nenhum passo; OWNER e ADMIN têm os quatro', async () => {
    const store = new InMemoryOnboardingStore();
    store.seed(A, { persona: true });
    const service = new OnboardingService(store);
    for (const role of ['OWNER', 'ADMIN'] as const) {
      const state = await service.get(A, (p) => hasPermission(role, p));
      assert.equal(Object.keys(state.steps).length, 4, role);
    }
    for (const role of ['AGENT', 'VIEWER'] as const) {
      const state = await service.get(A, (p) => hasPermission(role, p));
      assert.deepEqual(state.steps, {}, role);
    }
  });

  it('dispensar e reabrir só mexem na empresa da identidade; repetir não muda', async () => {
    const store = new InMemoryOnboardingStore();
    store.seed(A);
    store.seed(B);
    const service = new OnboardingService(store);
    const first = await service.setDismissed(A, true, everything);
    assert.equal(first.changed, true);
    assert.equal(first.state.dismissed, true);
    assert.equal((await service.setDismissed(A, true, everything)).changed, false);
    assert.equal((await service.get(B, everything)).dismissed, false);
    const reopened = await service.setDismissed(A, false, everything);
    assert.deepEqual([reopened.changed, reopened.state.dismissed], [true, false]);
  });
});
