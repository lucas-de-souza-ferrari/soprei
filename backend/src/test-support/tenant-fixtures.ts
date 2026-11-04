import { randomBytes } from 'node:crypto';
import { type Company, CompanyId } from '../domain/index.js';
import type { TenantScopedPrisma } from '../infrastructure/database/index.js';

/**
 * Empresas de teste: slug único por criação (nunca colide com dados de outro teste ou do
 * dono) e remoção só do que este objeto criou, e dos dados desses empresas.
 */
export class TestTenants {
  private readonly created = new Set<string>();

  constructor(private readonly db: TenantScopedPrisma) {}

  async createCompany(label = 'it', whatsappPhoneNumberId?: string): Promise<Company> {
    const slug = `${label}-${randomBytes(6).toString('hex')}`;
    const row = await this.db.company.create({
      data: {
        name: `Teste ${slug}`,
        slug,
        ...(whatsappPhoneNumberId === undefined ? {} : { whatsappPhoneNumberId }),
      },
    });
    this.created.add(row.id);
    return {
      id: CompanyId.parse(row.id),
      name: row.name,
      slug: row.slug,
      status: row.status,
      persona: row.persona,
      whatsappPhoneNumberId: row.whatsappPhoneNumberId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Registra uma empresa criada por outro caminho (ex.: pela API) para limpar no fim. */
  track(id: string): void {
    this.created.add(id);
  }

  async cleanup(): Promise<void> {
    for (const id of this.created) {
      // Auditoria antes dos usuários: as chaves estrangeiras compostas apontam para eles (Restrict).
      await this.db.channelConnection.deleteMany({ where: { companyId: id } });
      await this.db.auditEvent.deleteMany({ where: { companyId: id } });
      await this.db.membership.deleteMany({ where: { companyId: id } });
      // Mensagens antes das conversas: a chave estrangeira composta aponta para elas.
      await this.db.message.deleteMany({ where: { companyId: id } });
      await this.db.conversation.deleteMany({ where: { companyId: id } });
    }
    await this.db.company.deleteMany({ where: { id: { in: [...this.created] } } });
    this.created.clear();
  }
}
