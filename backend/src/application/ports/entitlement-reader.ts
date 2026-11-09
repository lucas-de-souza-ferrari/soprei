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
