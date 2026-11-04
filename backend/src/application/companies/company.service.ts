import {
  COMPANY_SLUG_PATTERN,
  COMPANY_STATUSES,
  type Company,
  type CompanyId,
  type CompanyRepository,
  type CompanyUpdate,
  type ListOptions,
  type NewCompany,
  PERSONA_MAX_LENGTH,
  type Page,
} from '../../domain/index.js';
import { ConflictError, ValidationError } from '../../shared/errors/index.js';

export const COMPANY_NAME_MAX_LENGTH = 120;

/**
 * Casos de uso de `Company` (a raiz do tenant). Não conhece Fastify nem Prisma: recebe o
 * repositório por injeção. Revalida o que recebe (o controller já validou com Zod) porque
 * o service também é chamado por outras camadas no futuro.
 */
export class CompanyService {
  constructor(private readonly companies: CompanyRepository) {}

  async create(input: NewCompany): Promise<Company> {
    const data: NewCompany = {
      name: parseName(input.name),
      slug: parseSlug(input.slug),
      ...(input.status === undefined ? {} : { status: parseStatus(input.status) }),
    };
    try {
      return await this.companies.create(data);
    } catch (error) {
      if (error instanceof ConflictError) {
        // O slug é a única chave natural da empresa: dizer isso ao admin ajuda e não vaza nada.
        throw new ConflictError('Já existe uma empresa com este slug', {
          cause: error,
          context: { slug: data.slug },
        });
      }
      throw error;
    }
  }

  getById(id: CompanyId): Promise<Company> {
    return this.companies.findById(id);
  }

  async getBySlug(slug: string): Promise<Company> {
    return await this.companies.findBySlug(parseSlug(slug));
  }

  list(options?: ListOptions): Promise<Page<Company>> {
    return this.companies.list(options);
  }

  /**
   * Atualiza nome, status e/ou persona (`null` limpa a persona). O slug não muda: ele identifica o
   * empresa para sempre. O número do WhatsApp **não** passa por aqui (spec 015): só o `OWNER`/`ADMIN`
   * da empresa o liga, pelo `PUT /admin/companies/:companyId/channel`.
   */
  async update(
    id: CompanyId,
    input: Omit<CompanyUpdate, 'whatsappPhoneNumberId'>,
  ): Promise<Company> {
    if (input.name === undefined && input.status === undefined && input.persona === undefined) {
      throw new ValidationError('Informe name, status ou persona');
    }
    const data: Omit<CompanyUpdate, 'whatsappPhoneNumberId'> = {
      ...(input.name === undefined ? {} : { name: parseName(input.name) }),
      ...(input.status === undefined ? {} : { status: parseStatus(input.status) }),
      ...(input.persona === undefined ? {} : { persona: parsePersona(input.persona) }),
    };
    return await this.companies.update(id, data);
  }

  /**
   * Persona da **própria** empresa (spec 023). Recebe só o `CompanyId` da identidade (nunca do caminho,
   * do corpo ou da query). O texto só volta a quem é dono do dado; nunca é logado.
   */
  async getPersona(companyId: CompanyId): Promise<string | null> {
    return (await this.companies.findById(companyId)).persona;
  }

  /** Grava (ou limpa, com `null`) a persona da própria empresa; devolve o que ficou gravado. */
  async setPersona(companyId: CompanyId, persona: string | null): Promise<string | null> {
    const updated = await this.companies.update(companyId, { persona: parsePersona(persona) });
    return updated.persona;
  }

  /** Soft delete: a empresa some das buscas, os dados e o slug permanecem. */
  remove(id: CompanyId): Promise<void> {
    return this.companies.delete(id);
  }
}

function parseName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > COMPANY_NAME_MAX_LENGTH) {
    throw new ValidationError(`name deve ter de 1 a ${String(COMPANY_NAME_MAX_LENGTH)} caracteres`);
  }
  return name;
}

/** `null` limpa a persona; texto vazio (ou só espaços) é inválido, nunca vira persona vazia. */
function parsePersona(value: string | null): string | null {
  if (value === null) return null;
  const persona = value.trim();
  if (persona.length === 0 || persona.length > PERSONA_MAX_LENGTH || persona.includes('\u0000')) {
    throw new ValidationError(
      `persona deve ter de 1 a ${String(PERSONA_MAX_LENGTH)} caracteres, sem NUL (ou null para limpar)`,
    );
  }
  return persona;
}

function parseSlug(value: string): string {
  if (!COMPANY_SLUG_PATTERN.test(value)) {
    throw new ValidationError(
      'slug deve ter de 3 a 63 caracteres: letras minúsculas, dígitos e hífen',
    );
  }
  return value;
}

function parseStatus(value: string): Company['status'] {
  const status = COMPANY_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new ValidationError(`status deve ser um de: ${COMPANY_STATUSES.join(', ')}`);
  }
  return status;
}
