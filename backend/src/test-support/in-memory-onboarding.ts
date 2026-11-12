import type { CompanyId } from '../domain/index.js';
import type {
  OnboardingFacts,
  OnboardingFactsWanted,
  OnboardingStore,
} from '../application/ports/onboarding-store.js';
import { NotFoundError } from '../shared/errors/index.js';

/** `OnboardingStore` em memória (spec 030): estado por empresa; empresa desconhecida é 404. */
export class InMemoryOnboardingStore implements OnboardingStore {
  readonly facts = new Map<string, OnboardingFacts>();
  readonly reads: OnboardingFactsWanted[] = [];

  seed(companyId: string, facts: Partial<OnboardingFacts> = {}): void {
    this.facts.set(companyId, {
      dismissed: false,
      persona: false,
      knowledge: false,
      schedule: false,
      inventory: false,
      ...facts,
    });
  }

  read(companyId: CompanyId, wanted: OnboardingFactsWanted): Promise<OnboardingFacts> {
    this.reads.push(wanted);
    const facts = this.facts.get(companyId);
    if (facts === undefined) return Promise.reject(new NotFoundError('Empresa não encontrada'));
    return Promise.resolve({
      dismissed: facts.dismissed,
      persona: wanted.persona && facts.persona,
      knowledge: wanted.knowledge && facts.knowledge,
      schedule: wanted.schedule && facts.schedule,
      inventory: wanted.inventory && facts.inventory,
    });
  }

  setDismissed(companyId: CompanyId, dismissed: boolean): Promise<boolean> {
    const facts = this.facts.get(companyId);
    if (facts === undefined) return Promise.reject(new NotFoundError('Empresa não encontrada'));
    const changed = facts.dismissed !== dismissed;
    this.facts.set(companyId, { ...facts, dismissed });
    return Promise.resolve(changed);
  }
}
