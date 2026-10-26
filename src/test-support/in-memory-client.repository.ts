import { randomUUID } from 'node:crypto';
import {
  type Client,
  ClientId,
  type ClientRepository,
  type ClientUpdate,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  MAX_LIST_LIMIT,
  type NewClient,
  type Page,
} from '../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors/index.js';

/**
 * `ClientRepository` em memória, para testes de service e de rota que não precisam de
 * banco. Mesmas regras do repositório real: slug único para sempre (inclusive de removido),
 * removido some das buscas. O cursor aqui é só a posição na lista.
 */
export class InMemoryClientRepository implements ClientRepository {
  private readonly rows: { client: Client; deleted: boolean }[] = [];

  findById(id: ClientId): Promise<Client> {
    return attempt(() => this.alive(id).client);
  }

  findBySlug(slug: string): Promise<Client> {
    const row = this.rows.find((candidate) => !candidate.deleted && candidate.client.slug === slug);
    if (row === undefined) return Promise.reject(notFound());
    return Promise.resolve(row.client);
  }

  list(options: ListOptions = {}): Promise<Page<Client>> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return Promise.reject(new ValidationError('limit inválido'));
    }
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) {
      return Promise.reject(new ValidationError('Cursor inválido'));
    }
    const alive = this.rows.filter((row) => !row.deleted).map((row) => row.client);
    const items = alive.slice(start, start + limit);
    const next = start + limit;
    return Promise.resolve({ items, nextCursor: next < alive.length ? String(next) : null });
  }

  create(data: NewClient): Promise<Client> {
    if (this.rows.some((row) => row.client.slug === data.slug)) {
      return Promise.reject(new ConflictError('Já existe um registro com estes dados'));
    }
    const now = new Date();
    const client: Client = {
      id: ClientId.parse(randomUUID()),
      name: data.name,
      slug: data.slug,
      status: data.status ?? 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push({ client, deleted: false });
    return Promise.resolve(client);
  }

  update(id: ClientId, data: ClientUpdate): Promise<Client> {
    return attempt(() => {
      const row = this.alive(id);
      row.client = { ...row.client, ...data, updatedAt: new Date() };
      return row.client;
    });
  }

  delete(id: ClientId): Promise<void> {
    return attempt(() => {
      this.alive(id).deleted = true;
    });
  }

  private alive(id: ClientId): { client: Client; deleted: boolean } {
    const row = this.rows.find((candidate) => !candidate.deleted && candidate.client.id === id);
    if (row === undefined) throw notFound();
    return row;
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Cliente não encontrado');
}

/** Erros viram rejeição da promise, como num repositório assíncrono de verdade. */
function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
