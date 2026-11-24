import type { CompanyId, CompanyStatus, NewPlatformAuditEvent } from '../../domain/index.js';

/**
 * Transação das ações do admin da plataforma sobre uma empresa (spec 044, E2, D1): trava a linha da
 * empresa (a mesma trava da gestão de usuários, `FOR NO KEY UPDATE`), grava o estado e o evento da trilha
 * juntos. O callback não faz chamada externa.
 */
export interface PlatformCompanyTransaction {
  /** Trava a empresa e devolve o estado atual. Inexistente ou removida: `NotFoundError`. */
  lockCompany(companyId: CompanyId): Promise<CompanyStatus>;
  setStatus(companyId: CompanyId, status: CompanyStatus): Promise<void>;
  audit(event: NewPlatformAuditEvent): Promise<void>;
}

export interface PlatformCompanyUnitOfWork {
  run<T>(fn: (tx: PlatformCompanyTransaction) => Promise<T>): Promise<T>;
}
