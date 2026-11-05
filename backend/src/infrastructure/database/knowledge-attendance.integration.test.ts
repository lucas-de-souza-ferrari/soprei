import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { InventoryService } from '../../application/inventory/inventory.service.js';
import { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import type { Company, Membership } from '../../domain/index.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaAttendanceUnitOfWork } from './repositories/attendance-unit-of-work.js';
import { PrismaCompanyRepository } from './repositories/company.repository.js';
import { PrismaConversationRepository } from './repositories/conversation.repository.js';
import {
  PrismaInventoryLedger,
  PrismaProductRepository,
  PrismaStockMovementRepository,
} from './repositories/inventory.repository.js';
import { PrismaKnowledgeDocumentRepository } from './repositories/knowledge-document.repository.js';
import { PrismaKnowledgeRetriever } from './repositories/knowledge-retriever.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';
import { PrismaMessageRepository } from './repositories/message.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const SECRET_TITLE = `Tabela secreta ${randomBytes(6).toString('hex')}`;
const SECRET_TEXT = `zzsegredo${randomBytes(6).toString('hex')}`;
const BATCH = { maxMessages: 10, maxChars: 8_000 };

let database: Database;
let tenants: TestTenants;
let service: AttendanceService;
let knowledge: KnowledgeService;
let inventory: InventoryService;
let llm: MockLlmProvider;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
const logs = captureLogs();

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  llm = new MockLlmProvider({ recordCalls: true });
  service = new AttendanceService({
    companies: new PrismaCompanyRepository(database.prisma),
    conversations: new PrismaConversationRepository(database.prisma),
    messages: new PrismaMessageRepository(database.prisma),
    unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
    llm,
    logger: logs.logger,
    options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000 },
    knowledge: new PrismaKnowledgeRetriever(database.prisma),
  });
  knowledge = new KnowledgeService(new PrismaKnowledgeDocumentRepository(database.prisma));
  inventory = new InventoryService({
    products: new PrismaProductRepository(database.prisma),
    movements: new PrismaStockMovementRepository(database.prisma),
    ledger: new PrismaInventoryLedger(database.prisma),
  });
  const memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('ka-a');
  companyB = await tenants.createCompany('ka-b');
  ownerA = await memberships.create(companyA.id, {
    email: `a-${randomBytes(4).toString('hex')}@exemplo.test`,
    passwordHash: HASH,
    role: 'OWNER',
  });
  await knowledge.create(companyA.id, ownerA.id, {
    title: SECRET_TITLE,
    content: `A garantia do aspirador cobre ${SECRET_TEXT} por doze meses.`,
  });
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

describe('atendimento com base de conhecimento, contra o PostgreSQL (spec 026, E1)', () => {
  it('simulador: a resposta do mock conta o trecho e as fontes são só rótulos', async () => {
    const result = await service.handleInboundMessage(companyA.id, {
      contactRef: 'ka-sim',
      text: 'qual a garantia do aspirador?',
    });
    assert.match(result.reply.text, /\(conhecimento: 1 trechos, 0 produtos\)$/);
    assert.deepEqual(result.sources, [{ kind: 'document', label: SECRET_TITLE }]);
    assert.equal(JSON.stringify(result.sources).includes(SECRET_TEXT), false);
    // O conteúdo vai ao modelo só no systemPrompt; o texto do contato só em userMessage.
    const call = llm.calls.find((entry) => entry.userMessage === 'qual a garantia do aspirador?');
    assert.ok(call !== undefined);
    assert.ok(call.systemPrompt.includes(SECRET_TEXT));
    assert.equal(call.userMessage.includes(SECRET_TEXT), false);
  });

  it('lote do canal (respondToPending) também recupera', async () => {
    await service.acceptInboundMessage(companyA.id, {
      contactRef: 'ka-canal',
      text: 'e a garantia do aspirador?',
    });
    const response = await service.respondToPending(companyA.id, 'ka-canal', BATCH);
    assert.equal(response.outcome, 'answered');
    assert.match(response.reply?.text ?? '', /\(conhecimento: 1 trechos, 0 produtos\)$/);
  });

  it('a outra empresa, com a mesma pergunta, não recebe nada da A', async () => {
    const result = await service.handleInboundMessage(companyB.id, {
      contactRef: 'ka-b',
      text: 'qual a garantia do aspirador?',
    });
    assert.deepEqual(result.sources, []);
    assert.equal(result.reply.text.includes('conhecimento:'), false);
    const call = llm.calls.findLast(
      (entry) => entry.userMessage === 'qual a garantia do aspirador?',
    );
    assert.equal(call?.systemPrompt.includes(SECRET_TEXT), false);
    assert.equal(call.systemPrompt.includes(SECRET_TITLE), false);
  });

  it('resposta repetida (mesmo externalId) devolve sources vazio', async () => {
    const input = {
      contactRef: 'ka-dup',
      text: 'garantia do aspirador, por favor',
      externalId: `ext-${randomBytes(4).toString('hex')}`,
    };
    const first = await service.handleInboundMessage(companyA.id, input);
    const again = await service.handleInboundMessage(companyA.id, input);
    assert.equal(first.sources.length, 1);
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.sources, []);
  });

  it('estoque: o produto entra no prompt com preço, quantidade e hora; fonte é só o nome; inativo e outra empresa não', async () => {
    const sold = await inventory.create(companyA.id, ownerA.id, {
      sku: 'ZZ-ASPIRADOR',
      name: 'Aspirador Turbo Zeta',
      description: 'Potente',
      priceCents: 45990,
      quantity: 4,
    });
    const result = await service.handleInboundMessage(companyA.id, {
      contactRef: 'ka-prod',
      text: 'quanto custa o aspirador turbo zeta?',
    });
    assert.ok(result.reply.text.endsWith(' trechos, 1 produtos)'));
    assert.ok(
      result.sources.some(
        (source) => source.kind === 'product' && source.label === 'Aspirador Turbo Zeta',
      ),
    );
    const call = llm.calls.findLast((entry) => entry.userMessage.includes('aspirador turbo zeta'));
    assert.ok(call !== undefined);
    assert.ok(call.systemPrompt.includes('R$ 459,90; 4 unidades em estoque'));
    // Sem estoque continua aparecendo, como "sem estoque no momento".
    await inventory.adjust(companyA.id, ownerA.id, sold.id, { delta: -4, reason: 'EXIT' });
    await service.handleInboundMessage(companyA.id, {
      contactRef: 'ka-prod',
      text: 'ainda tem o aspirador turbo zeta?',
    });
    const empty = llm.calls.findLast((entry) =>
      entry.userMessage.includes('ainda tem o aspirador'),
    );
    assert.ok(empty?.systemPrompt.includes('sem estoque no momento'));
    // A outra empresa não vê o produto da A.
    const other = await service.handleInboundMessage(companyB.id, {
      contactRef: 'ka-prod-b',
      text: 'quanto custa o aspirador turbo zeta?',
    });
    assert.deepEqual(other.sources, []);
    // Inativo não é usado.
    await inventory.update(companyA.id, sold.id, { active: false });
    const inactive = await service.handleInboundMessage(companyA.id, {
      contactRef: 'ka-prod',
      text: 'e o aspirador turbo zeta, tem?',
    });
    assert.ok(!inactive.sources.some((source) => source.kind === 'product'));
    for (const secret of ['Aspirador Turbo Zeta', 'ZZ-ASPIRADOR', '459,90']) {
      assert.equal(logContains(logs.raw(), secret), false, secret);
    }
  });

  it('privacidade: título, texto do documento e da pergunta não aparecem em nenhum log', () => {
    for (const secret of [SECRET_TITLE, SECRET_TEXT, 'garantia do aspirador']) {
      assert.equal(logContains(logs.raw(), secret), false, secret);
    }
  });
});
