import type { CompanyEntitlements, CompanyId } from '../../domain/index.js';

/**
 * O que a empresa pode fazer agora (spec 031): acesso, módulos contratados e cotas da janela. O
 * `CompanyId` vem só do contexto (token assinado ou job do canal); a implementação o resolve para a
 * assinatura da conta dona **no servidor**. Sem dinheiro no resultado. Só existe com `BILLING_ENABLED`;
 * sem a cobrança nenhuma instância é criada e o atendimento nem o consulta.
 */
export interface EntitlementReader {
  forCompany(companyId: CompanyId): Promise<CompanyEntitlements>;
}

/** Titularidade da assinatura (E4): a tela de Assinatura é da conta, então só o titular a vê. */
export interface SubscriptionHolderReader {
  /**
   * A conta do vínculo é a TITULAR da assinatura desta empresa? Só um booleano (a tela de Assinatura é da
   * conta, então só o titular a vê); nunca devolve dado de outra conta.
   */
  holderOf(companyId: CompanyId, membershipId: string): Promise<boolean>;
}
