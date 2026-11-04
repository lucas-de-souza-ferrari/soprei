import type {
  CompanyInvitation,
  InvitationClosing,
  InvitationRenewal,
  NewCompanyInvitation,
} from '../entities/company-invitation.js';
import type { ListOptions, Page } from '../pagination.js';
import type { CompanyId } from '../value-objects/company-id.js';

/**
 * Convites de uma empresa (spec 025). `CompanyId` é o primeiro parâmetro de todo método e entra em
 * todo `where`: convite de outra empresa se comporta como inexistente. Sem SQL cru.
 */
export interface CompanyInvitationRepository {
  /** Lança `NotFoundError` se o id não existe nesta empresa (inclusive id malformado). */
  findById(companyId: CompanyId, id: string): Promise<CompanyInvitation>;
  /** O convite `PENDING` (vencido ou não) para o e-mail já normalizado, ou `null`. */
  findPendingByEmail(companyId: CompanyId, email: string): Promise<CompanyInvitation | null>;
  /** `ConflictError` se já há convite `PENDING` do mesmo e-mail nesta empresa. */
  create(companyId: CompanyId, data: NewCompanyInvitation): Promise<CompanyInvitation>;
  /** Só os `PENDING`, mais antigos primeiro (`createdAt`, `id`), por cursor. */
  listPending(companyId: CompanyId, options?: ListOptions): Promise<Page<CompanyInvitation>>;
  /** Quantos `PENDING` ainda não vencidos (`expiresAt` depois de `now`). */
  countPending(companyId: CompanyId, now: Date): Promise<number>;
  /**
   * Novo segredo, nova validade e novo envio, só se ainda `PENDING` (soma 1 a `sendCount`). `null`
   * se o convite não está mais pendente.
   */
  renew(
    companyId: CompanyId,
    id: string,
    data: InvitationRenewal,
  ): Promise<CompanyInvitation | null>;
  /**
   * Fecha um convite `PENDING` anulando e-mail e hash. `false` se ele não existe nesta empresa ou
   * já estava fechado (nada é alterado).
   */
  close(companyId: CompanyId, id: string, closing: InvitationClosing): Promise<boolean>;
}

/** Expurgo do e-mail dos convites pendentes vencidos há muito tempo (spec 025). */
export interface InvitationExpiryRepository {
  /**
   * Fecha como `EXPIRED` (e-mail e hash anulados) até `batchSize` convites `PENDING` com
   * `expires_at` anterior a `cutoff`. O predicado é repetido no UPDATE sob lock: convite que o aceite
   * ou a revogação acabou de fechar nunca é revertido. Devolve só a contagem.
   */
  expirePending(cutoff: Date, batchSize: number): Promise<number>;
}
