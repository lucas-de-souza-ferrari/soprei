import { randomBytes } from 'node:crypto';
import { type Client, ClientId } from '../domain/index.js';
import type { TenantScopedPrisma } from '../infrastructure/database/index.js';

/**
 * Clientes de teste: slug único por criação (nunca colide com dados de outro teste ou do
 * dono) e remoção só do que este objeto criou, e dos dados desses clientes.
 */
export class TestTenants {
  private readonly created = new Set<string>();

  constructor(private readonly db: TenantScopedPrisma) {}

  async createClient(label = 'it', whatsappPhoneNumberId?: string): Promise<Client> {
    const slug = `${label}-${randomBytes(6).toString('hex')}`;
    const row = await this.db.client.create({
      data: {
        name: `Teste ${slug}`,
        slug,
        ...(whatsappPhoneNumberId === undefined ? {} : { whatsappPhoneNumberId }),
      },
    });
    this.created.add(row.id);
    return {
      id: ClientId.parse(row.id),
      name: row.name,
      slug: row.slug,
      status: row.status,
      persona: row.persona,
      whatsappPhoneNumberId: row.whatsappPhoneNumberId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Registra um cliente criado por outro caminho (ex.: pela API) para limpar no fim. */
  track(id: string): void {
    this.created.add(id);
  }

  async cleanup(): Promise<void> {
    for (const id of this.created) {
      // Auditoria antes dos usuários: as chaves estrangeiras compostas apontam para eles (Restrict).
      await this.db.channelConnection.deleteMany({ where: { clientId: id } });
      await this.db.auditEvent.deleteMany({ where: { clientId: id } });
      await this.db.user.deleteMany({ where: { clientId: id } });
      // Mensagens antes das conversas: a chave estrangeira composta aponta para elas.
      await this.db.message.deleteMany({ where: { clientId: id } });
      await this.db.conversation.deleteMany({ where: { clientId: id } });
    }
    await this.db.client.deleteMany({ where: { id: { in: [...this.created] } } });
    this.created.clear();
  }
}
