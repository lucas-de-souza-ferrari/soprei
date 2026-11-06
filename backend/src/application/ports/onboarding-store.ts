import type { CompanyId } from '../../domain/index.js';

/** O que existe hoje na empresa, só como booleanos (spec 030): nunca texto, nome, SKU nem id. */
export interface OnboardingFacts {
  readonly dismissed: boolean;
  /** Persona definida (diferente de nulo). */
  readonly persona: boolean;
  /** Existe ao menos um documento. */
  readonly knowledge: boolean;
  /** Existe ao menos um serviço da agenda **ativo**. */
  readonly schedule: boolean;
  /** Existe ao menos um produto **ativo**. */
  readonly inventory: boolean;
}

/** Quais fatos o chamador precisa (só se consulta o que a pessoa tem permissão de ver). */
export type OnboardingFactsWanted = Readonly<
  Record<'persona' | 'knowledge' | 'schedule' | 'inventory', boolean>
>;

/**
 * Leitura e escrita do estado do assistente de primeiros passos. `CompanyId` primeiro em todo método; a
 * implementação filtra por empresa em toda consulta (spec 030). Sem SQL cru.
 */
export interface OnboardingStore {
  /** `NotFoundError` se a empresa não existe ou foi removida. Campos não pedidos voltam `false`. */
  read(companyId: CompanyId, wanted: OnboardingFactsWanted): Promise<OnboardingFacts>;
  /**
   * Dispensa (grava a data só se ainda não estava dispensado: idempotente) ou reabre (anula).
   * `NotFoundError` se a empresa não existe. Devolve se a ação **mudou** o estado.
   */
  setDismissed(companyId: CompanyId, dismissed: boolean): Promise<boolean>;
}
