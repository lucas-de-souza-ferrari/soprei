import { randomUUID } from 'node:crypto';
import {
  type Company,
  CompanyId,
  type CompanyRepository,
  type CompanyUpdate,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  MAX_LIST_LIMIT,
  type NewCompany,
  type Page,
} from '../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors/index.js';

/**
 * `CompanyRepository` em memória, para testes de service e de rota que não precisam de
 * banco. Mesmas regras do repositório real: slug único para sempre (inclusive de removido),
 * removido some das buscas. O cursor aqui é só a posição na lista.
 */
export class InMemoryCompanyRepository implements CompanyRepository {
  private readonly rows: { company: Company; deleted: boolean }[] = [];

  findById(id: CompanyId): Promise<Company> {
    return attempt(() => this.alive(id).company);
  }

  findBySlug(slug: string): Promise<Company> {
    const row = this.rows.find(
      (candidate) => !candidate.deleted && candidate.company.slug === slug,
    );
    if (row === undefined) return Promise.reject(notFound());
    return Promise.resolve(row.company);
  }

  findByWhatsappPhoneNumberId(phoneNumberId: string): Promise<Company | null> {
    const row = this.rows.find(
      (candidate) =>
        !candidate.deleted && candidate.company.whatsappPhoneNumberId === phoneNumberId,
    );
    return Promise.resolve(row?.company ?? null);
  }

  list(options: ListOptions = {}): Promise<Page<Company>> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return Promise.reject(new ValidationError('limit inválido'));
    }
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) {
      return Promise.reject(new ValidationError('Cursor inválido'));
    }
    const alive = this.rows.filter((row) => !row.deleted).map((row) => row.company);
    const items = alive.slice(start, start + limit);
    const next = start + limit;
    return Promise.resolve({ items, nextCursor: next < alive.length ? String(next) : null });
  }

  create(data: NewCompany): Promise<Company> {
    if (this.rows.some((row) => row.company.slug === data.slug)) {
      return Promise.reject(new ConflictError('Já existe um registro com estes dados'));
    }
    const now = new Date();
    const company: Company = {
      id: CompanyId.parse(randomUUID()),
      name: data.name,
      slug: data.slug,
      status: data.status ?? 'ACTIVE',
      persona: null,
      whatsappPhoneNumberId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push({ company, deleted: false });
    return Promise.resolve(company);
  }

  update(id: CompanyId, data: CompanyUpdate): Promise<Company> {
    return attempt(() => {
      const row = this.alive(id);
      const number = data.whatsappPhoneNumberId;
      if (
        number !== undefined &&
        number !== null &&
        this.rows.some((other) => other !== row && other.company.whatsappPhoneNumberId === number)
      ) {
        throw new ConflictError('Já existe um registro com estes dados');
      }
      row.company = { ...row.company, ...data, updatedAt: new Date() };
      return row.company;
    });
  }

  delete(id: CompanyId): Promise<void> {
    return attempt(() => {
      const row = this.alive(id);
      row.deleted = true;
      // Como o repositório real: o número do WhatsApp é liberado junto.
      row.company = { ...row.company, whatsappPhoneNumberId: null };
    });
  }

  private alive(id: CompanyId): { company: Company; deleted: boolean } {
    const row = this.rows.find((candidate) => !candidate.deleted && candidate.company.id === id);
    if (row === undefined) throw notFound();
    return row;
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrado');
}

/** Erros viram rejeição da promise, como num repositório assíncrono de verdade. */
function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
