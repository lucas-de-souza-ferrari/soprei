import type {
  AccountId,
  NewPlatformAuditEvent,
  PlanCode,
  SubscriptionRecord,
} from '../../domain/index.js';

/** O que a ação muda na linha da assinatura (spec 045, E4); campo ausente = não muda. */
export interface PlatformSubscriptionPatch {
  readonly status?: SubscriptionRecord['status'];
  readonly currentPeriodEnd?: Date;
  readonly trialEndsAt?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly agendaEnabled?: boolean;
  readonly stockEnabled?: boolean;
  /** Plano e preço novos (o preço vigente do catálogo para o ciclo atual). */
  readonly planId?: string;
  readonly priceId?: string;
  /** `null` apaga a troca agendada. */
  readonly clearPendingChange?: boolean;
}

/** O plano do catálogo vigente que a troca aplicaria (só o necessário para a regra e a escrita). */
export interface PlatformPlanTarget {
  readonly planId: string;
  readonly priceId: string;
  readonly maxCompanies: number;
}

/**
 * Transação das ações do admin da plataforma sobre a assinatura de uma conta (spec 045, E4, regra comum 4):
 * travas na ordem **empresas em que a conta é dona -> conta -> assinatura** (como o aceite da 025 e a E2),
 * releitura, regra, escrita e `PlatformAuditEvent`. O callback não faz chamada externa.
 */
export interface PlatformSubscriptionTransaction {
  /** Trava as empresas (não removidas) em que a conta é `OWNER` ativa, em ordem de id (as que o teste adota). */
  lockOwnedCompanies(accountId: AccountId): Promise<number>;
  /** Trava a conta e relê o estado; `null` se não existe (revisão da E4, M5: o teste exige conta apta). */
  lockAccount(
    accountId: AccountId,
  ): Promise<{ readonly status: 'ACTIVE' | 'DISABLED'; readonly verified: boolean } | null>;
  /** Trava e relê a assinatura da conta; `null` se a conta não tem assinatura. */
  lockSubscription(accountId: AccountId): Promise<SubscriptionRecord | null>;
  /**
   * Há pedido desta assinatura que ainda pode ser pago e concedido? `PENDING`, ou `EXPIRED` com link, criado
   * dentro da janela da reconciliação (48 h). Sim = 409 `ORDER_PENDING`.
   */
  hasPendingOrder(subscriptionId: string, now: Date): Promise<boolean>;
  /**
   * Cria o teste gratuito como a 031 (Essencial, Agenda e Estoque, `trialDays`) e adota as empresas em que a
   * conta é `OWNER` ativa ainda sem assinatura. Devolve quantas adotou.
   */
  startTrial(accountId: AccountId, now: Date, trialDays: number): Promise<number>;
  /** O plano vigente do catálogo para o código e o ciclo; `null` se não existe (catálogo sem o par). */
  planTarget(
    planCode: PlanCode,
    cycle: SubscriptionRecord['cycle'],
    now: Date,
  ): Promise<PlatformPlanTarget | null>;
  /** Empresas da conta que contam no limite do plano, inclusive as ainda não adotadas (a regra da 031). */
  countCompanies(accountId: AccountId): Promise<number>;
  update(subscriptionId: string, patch: PlatformSubscriptionPatch): Promise<void>;
  audit(event: NewPlatformAuditEvent): Promise<void>;
}

export interface PlatformSubscriptionUnitOfWork {
  run<T>(fn: (tx: PlatformSubscriptionTransaction) => Promise<T>): Promise<T>;
}
