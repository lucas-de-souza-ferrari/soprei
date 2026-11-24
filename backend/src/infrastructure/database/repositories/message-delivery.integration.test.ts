import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Company } from '../../../domain/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaMessageRepository } from './message.repository.js';

// Spec 035 (revisão, I1 e I4): origem da resposta (atendeu lote do canal?) e marca de entrega incerta,
// contra o Postgres real (soprei_test), com isolamento entre empresas e o CHECK da migration.
const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let repo: PrismaMessageRepository;
let companyA: Company;
let companyB: Company;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  repo = new PrismaMessageRepository(database.prisma);
  companyA = await tenants.createCompany('entrega-a');
  companyB = await tenants.createCompany('entrega-b');
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

/** Conversa com uma mensagem do contato e uma resposta; `batch` liga a mensagem à resposta. */
async function seed(company: Company, batch: boolean) {
  const db = database.prisma;
  const conversation = await db.conversation.create({
    data: {
      companyId: company.id,
      contactRef: `5511${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0')}`,
    },
  });
  const user = await db.message.create({
    data: { companyId: company.id, conversationId: conversation.id, role: 'USER', content: 'oi' },
  });
  const reply = await db.message.create({
    data: {
      companyId: company.id,
      conversationId: conversation.id,
      role: 'ASSISTANT',
      content: 'resposta',
      replyToId: user.id,
      createdAt: new Date(user.createdAt.getTime() + 1),
    },
  });
  if (batch) {
    await db.message.updateMany({
      where: { companyId: company.id, id: user.id },
      data: { answeredById: reply.id },
    });
  }
  return { user, reply };
}

describe('MessageRepository: origem e entrega incerta (spec 035, revisão)', () => {
  it('isBatchReply: verdadeiro só para a resposta que atendeu lote, e só na própria empresa', async () => {
    const batch = await seed(companyA, true);
    const simulated = await seed(companyA, false);
    assert.equal(await repo.isBatchReply(companyA.id, batch.reply.id), true);
    assert.equal(await repo.isBatchReply(companyA.id, simulated.reply.id), false);
    assert.equal(await repo.isBatchReply(companyB.id, batch.reply.id), false, 'outra empresa');
    assert.equal(await repo.isBatchReply(companyA.id, 'nao-e-uuid'), false);
  });

  it('markDeliveryUncertain: marca uma vez, só resposta sem sentAt da própria empresa', async () => {
    const { user, reply } = await seed(companyA, true);
    const when = new Date();
    assert.equal(
      await repo.markDeliveryUncertain(companyB.id, reply.id, when),
      false,
      'outra empresa',
    );
    assert.equal(
      await repo.markDeliveryUncertain(companyA.id, user.id, when),
      false,
      'mensagem do contato',
    );
    assert.equal(await repo.markDeliveryUncertain(companyA.id, reply.id, when), true);
    assert.equal(
      await repo.markDeliveryUncertain(companyA.id, reply.id, when),
      false,
      'já marcada',
    );
    const stored = await repo.findById(companyA.id, reply.id);
    assert.equal(stored.deliveryUncertainAt?.getTime(), when.getTime());
  });

  it('o banco recusa a marca em mensagem do contato (CHECK da migration)', async () => {
    const { user } = await seed(companyA, false);
    await assert.rejects(
      database.prisma.message.updateMany({
        where: { companyId: companyA.id, id: user.id },
        data: { deliveryUncertainAt: new Date() },
      }),
    );
  });
});
