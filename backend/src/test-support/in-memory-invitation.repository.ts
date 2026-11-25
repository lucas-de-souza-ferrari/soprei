import { randomUUID } from 'node:crypto';
import {
  type CompanyId,
  type CompanyInvitation,
  type CompanyInvitationRepository,
  DEFAULT_LIST_LIMIT,
  type InvitationClosing,
  type InvitationRenewal,
  type ListOptions,
  type NewCompanyInvitation,
  type Page,
} from '../domain/index.js';
import { ConflictError, NotFoundError } from '../shared/errors/index.js';
import { isUuid } from '../shared/utils/index.js';

/**
 * `CompanyInvitationRepository` em memória com o mesmo isolamento e as mesmas regras do real: tudo
 * filtrado por `CompanyId`, um `PENDING` por e-mail e empresa, e e-mail e hash anulados ao fechar.
 */
export class InMemoryInvitationRepository implements CompanyInvitationRepository {
  private rows: CompanyInvitation[] = [];

  /** Atalho dos testes: cópia de todas as linhas (de todas as empresas). */
  all(): readonly CompanyInvitation[] {
    return this.rows.map((row) => ({ ...row }));
  }

  findById(companyId: CompanyId, id: string): Promise<CompanyInvitation> {
    const row = isUuid(id)
      ? this.rows.find((item) => item.companyId === companyId && item.id === id)
      : undefined;
    if (row === undefined) return Promise.reject(new NotFoundError('Recurso não encontrado'));
    return Promise.resolve({ ...row });
  }

  findPendingByEmail(companyId: CompanyId, email: string): Promise<CompanyInvitation | null> {
    const row = this.rows.find(
      (item) => item.companyId === companyId && item.status === 'PENDING' && item.email === email,
    );
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  create(companyId: CompanyId, data: NewCompanyInvitation): Promise<CompanyInvitation> {
    const duplicate = this.rows.some(
      (item) =>
        item.companyId === companyId && item.status === 'PENDING' && item.email === data.email,
    );
    if (duplicate) {
      return Promise.reject(new ConflictError('Já existe um registro com estes dados'));
    }
    const row: CompanyInvitation = {
      id: randomUUID(),
      companyId,
      email: data.email,
      role: data.role,
      status: 'PENDING',
      tokenHash: data.tokenHash,
      invitedByMembershipId: data.invitedByMembershipId ?? null,
      invitedByAdminId: data.invitedByAdminId ?? null,
      acceptedMembershipId: null,
      expiresAt: data.expiresAt,
      lastSentAt: data.now,
      sendCount: 1,
      createdAt: data.now,
      closedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  listPending(companyId: CompanyId, options: ListOptions = {}): Promise<Page<CompanyInvitation>> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const all = this.rows
      .filter((item) => item.companyId === companyId && item.status === 'PENDING')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const items = all.slice(start, start + limit).map((row) => ({ ...row }));
    const next = start + limit;
    return Promise.resolve({ items, nextCursor: next < all.length ? String(next) : null });
  }

  countPending(companyId: CompanyId, now: Date): Promise<number> {
    return Promise.resolve(
      this.rows.filter(
        (item) =>
          item.companyId === companyId &&
          item.status === 'PENDING' &&
          item.expiresAt.getTime() > now.getTime(),
      ).length,
    );
  }

  renew(
    companyId: CompanyId,
    id: string,
    data: InvitationRenewal,
  ): Promise<CompanyInvitation | null> {
    const index = this.rows.findIndex(
      (item) => item.companyId === companyId && item.id === id && item.status === 'PENDING',
    );
    const current = this.rows[index];
    if (current === undefined) return Promise.resolve(null);
    const updated: CompanyInvitation = {
      ...current,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      lastSentAt: data.lastSentAt,
      sendCount: current.sendCount + 1,
    };
    this.rows[index] = updated;
    return Promise.resolve({ ...updated });
  }

  close(companyId: CompanyId, id: string, closing: InvitationClosing): Promise<boolean> {
    const index = this.rows.findIndex(
      (item) => item.companyId === companyId && item.id === id && item.status === 'PENDING',
    );
    const current = this.rows[index];
    if (current === undefined) return Promise.resolve(false);
    this.rows[index] = {
      ...current,
      status: closing.status,
      closedAt: closing.closedAt,
      email: null,
      tokenHash: null,
      acceptedMembershipId: closing.acceptedMembershipId ?? null,
    };
    return Promise.resolve(true);
  }
}
