import type {
  Company,
  CompanyId,
  CompanyRepository,
  CompanyUpdate,
  ListOptions,
  NewCompany,
  Page,
} from '../../../domain/index.js';
import { WHATSAPP_PHONE_NUMBER_ID_PATTERN } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { buildPageQuery, stableOrderBy, toPage } from './cursor.js';
import { toCompany } from './mappers.js';
import { withRepositoryErrors } from './repository-errors.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';

/**
 * `Company` é a raiz do tenant (model global): não é filtrado por `companyId`. Empresas
 * removidos (soft delete, `deletedAt`) somem de buscas e listagens, mas a linha continua e
 * o slug fica reservado para sempre (a unicidade do banco vale para todas as linhas).
 */
export class PrismaCompanyRepository implements CompanyRepository {
  constructor(private readonly db: TenantScopedDb) {}

  /** O mesmo repositório sobre o client de uma transação (`runInTransaction`). */
  forTransaction(tx: TenantScopedDb): CompanyRepository {
    return new PrismaCompanyRepository(tx);
  }

  findById(id: CompanyId): Promise<Company> {
    return withRepositoryErrors('Company.findById', async () => {
      const row = await this.db.company.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw notFound();
      return toCompany(row);
    });
  }

  findBySlug(slug: string): Promise<Company> {
    return withRepositoryErrors('Company.findBySlug', async () => {
      const row = await this.db.company.findFirst({ where: { slug, deletedAt: null } });
      if (row === null) throw notFound();
      return toCompany(row);
    });
  }

  findByWhatsappPhoneNumberId(phoneNumberId: string): Promise<Company | null> {
    return withRepositoryErrors('Company.findByWhatsappPhoneNumberId', async () => {
      // Formato inválido nunca casa com nada: não vai ao banco. Empresa removida não aparece.
      if (!WHATSAPP_PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) return null;
      const row = await this.db.company.findFirst({
        where: { whatsappPhoneNumberId: phoneNumberId, deletedAt: null },
      });
      return row === null ? null : toCompany(row);
    });
  }

  list(options?: ListOptions): Promise<Page<Company>> {
    return withRepositoryErrors('Company.list', async () => {
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.db.company.findMany({
        where: { deletedAt: null, ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, toCompany);
    });
  }

  create(data: NewCompany): Promise<Company> {
    return withRepositoryErrors('Company.create', async () => {
      const row = await this.db.company.create({
        data: {
          name: data.name,
          slug: data.slug,
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      });
      return toCompany(row);
    });
  }

  update(id: CompanyId, data: CompanyUpdate): Promise<Company> {
    return withRepositoryErrors('Company.update', async () => {
      const { count } = await this.db.company.updateMany({
        where: { id, deletedAt: null },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.status === undefined ? {} : { status: data.status }),
          ...(data.persona === undefined ? {} : { persona: data.persona }),
          ...(data.whatsappPhoneNumberId === undefined
            ? {}
            : { whatsappPhoneNumberId: data.whatsappPhoneNumberId }),
        },
      });
      if (count === 0) throw notFound();
      const row = await this.db.company.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw notFound();
      return toCompany(row);
    });
  }

  delete(id: CompanyId): Promise<void> {
    return withRepositoryErrors('Company.delete', async () => {
      const remove = async (db: TenantScopedDb): Promise<void> => {
        const { count } = await db.company.updateMany({
          where: { id, deletedAt: null },
          // O número do WhatsApp é liberado junto: uma empresa removida não recebe mais mensagens e o
          // número pode ser ligado a outra empresa.
          data: { deletedAt: new Date(), whatsappPhoneNumberId: null },
        });
        if (count === 0) throw notFound();
        // Spec 015: a credencial do canal (texto cifrado) some na mesma transação.
        await db.channelConnection.deleteMany({ where: { companyId: id } });
      };
      // Fora de uma transação (company raiz) abre uma; dentro de uma, já está nela.
      if ('$transaction' in this.db) {
        await runInTransaction(this.db as TenantScopedPrisma, remove);
      } else {
        await remove(this.db);
      }
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrado', { context: { entity: 'Company' } });
}
