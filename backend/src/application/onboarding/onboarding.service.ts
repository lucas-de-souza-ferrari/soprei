import type { CompanyId, Permission } from '../../domain/index.js';
import type { OnboardingFactsWanted, OnboardingStore } from '../ports/onboarding-store.js';

/** Um passo do assistente só existe na resposta se quem pede tem a permissão dele (spec 030). */
export const ONBOARDING_STEP_PERMISSIONS = {
  persona: 'persona:manage',
  knowledge: 'knowledge:manage',
  schedule: 'schedule:configure',
  inventory: 'inventory:manage',
} as const satisfies Record<string, Permission>;

export type OnboardingStepKey = keyof typeof ONBOARDING_STEP_PERMISSIONS;

export interface OnboardingState {
  readonly dismissed: boolean;
  readonly steps: Partial<Record<OnboardingStepKey, boolean>>;
}

const STEP_KEYS = Object.keys(ONBOARDING_STEP_PERMISSIONS) as OnboardingStepKey[];

/**
 * Estado do assistente de primeiros passos (spec 030). Recebe **só** o `CompanyId` da identidade e uma
 * função de permissão (o service não conhece papéis). O progresso é derivado do que já existe; a única
 * coisa gravada é "dispensado". Nada devolvido ou logado contém texto, nome ou id de dado da empresa.
 */
export class OnboardingService {
  constructor(private readonly store: OnboardingStore) {}

  async get(
    companyId: CompanyId,
    can: (permission: Permission) => boolean,
  ): Promise<OnboardingState> {
    const wanted = Object.fromEntries(
      STEP_KEYS.map((key) => [key, can(ONBOARDING_STEP_PERMISSIONS[key])]),
    ) as OnboardingFactsWanted;
    const facts = await this.store.read(companyId, wanted);
    const steps: Partial<Record<OnboardingStepKey, boolean>> = {};
    for (const key of STEP_KEYS) {
      if (wanted[key]) steps[key] = facts[key];
    }
    return { dismissed: facts.dismissed, steps };
  }

  /** Devolve o estado novo e se a escrita mudou algo (para a métrica). */
  async setDismissed(
    companyId: CompanyId,
    dismissed: boolean,
    can: (permission: Permission) => boolean,
  ): Promise<{ state: OnboardingState; changed: boolean }> {
    const changed = await this.store.setDismissed(companyId, dismissed);
    return { state: await this.get(companyId, can), changed };
  }
}
