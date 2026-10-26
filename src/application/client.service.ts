import {
  CLIENT_SLUG_PATTERN,
  CLIENT_STATUSES,
  type Client,
  type ClientId,
  type ClientRepository,
  type ClientUpdate,
  type ListOptions,
  type NewClient,
  type Page,
} from '../domain/index.js';
import { ConflictError, ValidationError } from '../shared/errors/index.js';

export const CLIENT_NAME_MAX_LENGTH = 120;

/**
 * Casos de uso de `Client` (a raiz do tenant). Não conhece Fastify nem Prisma: recebe o
 * repositório por injeção. Revalida o que recebe (o controller já validou com Zod) porque
 * o service também é chamado por outras camadas no futuro.
 */
export class ClientService {
  constructor(private readonly clients: ClientRepository) {}

  async create(input: NewClient): Promise<Client> {
    const data: NewClient = {
      name: parseName(input.name),
      slug: parseSlug(input.slug),
      ...(input.status === undefined ? {} : { status: parseStatus(input.status) }),
    };
    try {
      return await this.clients.create(data);
    } catch (error) {
      if (error instanceof ConflictError) {
        // O slug é a única chave natural do cliente: dizer isso ao admin ajuda e não vaza nada.
        throw new ConflictError('Já existe um cliente com este slug', {
          cause: error,
          context: { slug: data.slug },
        });
      }
      throw error;
    }
  }

  getById(id: ClientId): Promise<Client> {
    return this.clients.findById(id);
  }

  async getBySlug(slug: string): Promise<Client> {
    return await this.clients.findBySlug(parseSlug(slug));
  }

  list(options?: ListOptions): Promise<Page<Client>> {
    return this.clients.list(options);
  }

  /** Atualiza nome e/ou status. O slug não muda: ele identifica o cliente para sempre. */
  async update(id: ClientId, input: ClientUpdate): Promise<Client> {
    if (input.name === undefined && input.status === undefined) {
      throw new ValidationError('Informe name ou status para atualizar');
    }
    const data: ClientUpdate = {
      ...(input.name === undefined ? {} : { name: parseName(input.name) }),
      ...(input.status === undefined ? {} : { status: parseStatus(input.status) }),
    };
    return await this.clients.update(id, data);
  }

  /** Soft delete: o cliente some das buscas, os dados e o slug permanecem. */
  remove(id: ClientId): Promise<void> {
    return this.clients.delete(id);
  }
}

function parseName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > CLIENT_NAME_MAX_LENGTH) {
    throw new ValidationError(`name deve ter de 1 a ${String(CLIENT_NAME_MAX_LENGTH)} caracteres`);
  }
  return name;
}

function parseSlug(value: string): string {
  if (!CLIENT_SLUG_PATTERN.test(value)) {
    throw new ValidationError(
      'slug deve ter de 3 a 63 caracteres: letras minúsculas, dígitos e hífen',
    );
  }
  return value;
}

function parseStatus(value: string): Client['status'] {
  const status = CLIENT_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new ValidationError(`status deve ser um de: ${CLIENT_STATUSES.join(', ')}`);
  }
  return status;
}
