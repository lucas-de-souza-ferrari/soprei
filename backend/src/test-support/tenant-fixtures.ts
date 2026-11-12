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
      // Notificações (spec 038) antes de vínculos, mensagens e conversas (chaves estrangeiras compostas).
      await this.db.notification.deleteMany({ where: { companyId: id } });
      await this.db.auditEvent.deleteMany({ where: { companyId: id } });
      // Convites antes dos vínculos (as chaves estrangeiras compostas apontam para eles) e depois da auditoria.
      await this.db.companyInvitation.deleteMany({ where: { companyId: id } });
      // Trechos e documentos da base de conhecimento antes dos vínculos (o autor é chave estrangeira composta).
      // Agenda (spec 027): agendamentos antes de recursos e serviços (chaves estrangeiras compostas) e dos vínculos.
      await this.db.appointment.deleteMany({ where: { companyId: id } });
      await this.db.availabilityRule.deleteMany({ where: { companyId: id } });
      await this.db.scheduleService.deleteMany({ where: { companyId: id } });
      await this.db.scheduleResource.deleteMany({ where: { companyId: id } });
      await this.db.scheduleSettings.deleteMany({ where: { companyId: id } });
      await this.db.stockMovement.deleteMany({ where: { companyId: id } });
      await this.db.product.deleteMany({ where: { companyId: id } });
      await this.db.knowledgeChunk.deleteMany({ where: { companyId: id } });
      await this.db.knowledgeDocument.deleteMany({ where: { companyId: id } });
      await this.db.membership.deleteMany({ where: { companyId: id } });
      // Mensagens antes das conversas: a chave estrangeira composta aponta para elas.
      await this.db.message.deleteMany({ where: { companyId: id } });
      await this.db.conversation.deleteMany({ where: { companyId: id } });
    }
    await this.db.company.deleteMany({ where: { id: { in: [...this.created] } } });
    this.created.clear();
  }
}
