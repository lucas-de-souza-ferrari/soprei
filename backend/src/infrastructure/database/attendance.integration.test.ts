import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import {
  ATTENDANCE_FALLBACK_TEXT,
  AttendanceService,
  ATTENDANCE_STYLE_INSTRUCTION,
} from '../../application/attendance/attendance.service.js';
import type { Company } from '../../domain/index.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { MOCK_FAIL_MARKER, MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { createLogger } from '../logger/logger.js';
import { PrismaAttendanceUnitOfWork } from './repositories/attendance-unit-of-work.js';
import { PrismaCompanyRepository } from './repositories/company.repository.js';
import { PrismaConversationRepository } from './repositories/conversation.repository.js';
import { createDatabase, type Database } from './database.js';
import { PrismaMessageRepository } from './repositories/message.repository.js';
import { runInTransaction } from './transaction.js';
import type { AttendanceTransaction, AttendanceUnitOfWork } from '../../domain/index.js';

const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let companies: PrismaCompanyRepository;
let conversations: PrismaConversationRepository;
let messages: PrismaMessageRepository;
let llm: MockLlmProvider;
let service: AttendanceService;
const logs = captureLogs();

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  companies = new PrismaCompanyRepository(database.prisma);
  conversations = new PrismaConversationRepository(database.prisma);
  messages = new PrismaMessageRepository(database.prisma);
  llm = new MockLlmProvider({ recordCalls: true });
  service = new AttendanceService({
    companies,
    conversations,
    messages,
    unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
    llm,
    logger: logs.logger,
    options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000 },
  });
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function companyWithPersona(label: string, persona?: string): Promise<Company> {
  const company = await tenants.createCompany(label);
  return persona === undefined ? company : companies.update(company.id, { persona });
}

/** Chamadas ao LLM cujo `userMessage` começa com `prefix` (isola testes que compartilham o mock). */
const callsFor = (prefix: string) =>
  llm.calls.filter((call) => call.userMessage.startsWith(prefix));

/** O systemPrompt que o serviço envia: persona e, depois, a instrução fixa de estilo (spec 014). */
function withStyle(persona: string): string {
  return `${persona}\n\n${ATTENDANCE_STYLE_INSTRUCTION}`;
}

describe('atendimento contra o PostgreSQL de testes', () => {
  it('pipeline completo: conversa por contactRef, mensagem do contato e resposta gravadas', async () => {
    const company = await companyWithPersona('att-e2e', 'Persona-E2E');
    const first = await service.handleInboundMessage(company.id, {
      contactRef: 'contato-e2e',
      text: 'e2e-um',
    });
    // A ordem da conversa é por `createdAt` (ms): sem uma folga, a pergunta seguinte pode cair no
    // mesmo milissegundo da resposta anterior e inverter a ordem que este teste confere.
    await sleep(5);
    const second = await service.handleInboundMessage(company.id, {
      contactRef: 'contato-e2e',
      text: 'e2e-dois',
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.conversationId, first.conversationId);
    assert.match(
      first.reply.text,
      /^\[mock\] Recebi: e2e-um \(persona: "Persona-E2E"; histórico: 0\)/,
    );
    assert.match(second.reply.text, /histórico: 2/);

    const stored = (await messages.listByConversation(company.id, first.conversationId)).items;
    assert.deepEqual(
      stored.map((m) => [m.role, m.content === first.reply.text ? 'r1' : m.content]),
      [
        ['USER', 'e2e-um'],
        ['ASSISTANT', 'r1'],
        ['USER', 'e2e-dois'],
        ['ASSISTANT', second.reply.text],
      ],
    );
    assert.equal(stored[1]?.replyToId, stored[0]?.id);
    assert.equal(stored[3]?.replyToId, stored[2]?.id);
    assert.ok(stored.every((m) => !m.isFallback));

    const [call] = callsFor('e2e-dois');
    assert.equal(call?.systemPrompt, withStyle('Persona-E2E'));
    assert.deepEqual(
      call.history.map((turn) => turn.role),
      ['user', 'assistant'],
    );
  });

  it('falha do provider: o fallback é gravado com isFallback = true no banco', async () => {
    const company = await companyWithPersona('att-fb');
    const result = await service.handleInboundMessage(company.id, {
      contactRef: 'contato-fb',
      text: `fb ${MOCK_FAIL_MARKER}`,
    });
    assert.equal(result.reply.text, ATTENDANCE_FALLBACK_TEXT);
    assert.equal(result.reply.isFallback, true);
    const stored = await messages.findById(company.id, result.reply.id);
    assert.equal(stored.isFallback, true);
    assert.equal(stored.content, ATTENDANCE_FALLBACK_TEXT);
    assert.equal(stored.replyToId, result.messageId);
  });

  it('a chamada ao LLM fica fora da transação: com o provider bloqueado, nenhuma transação está aberta', async () => {
    const company = await companyWithPersona('att-tx');
    const release = llm.hold();
    const before = llm.calls.length;
    const pending = service.handleInboundMessage(company.id, {
      contactRef: 'contato-tx',
      text: 'tx-bloqueado',
    });
    try {
      for (let i = 0; i < 200 && llm.calls.length === before; i++) await sleep(10);
      assert.equal(llm.calls.length, before + 1, 'o provider foi chamado e está bloqueado');

      const open = await database.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND (state LIKE 'idle in transaction%' OR xact_start IS NOT NULL AND state = 'active')`;
      assert.equal(open[0]?.total, 0n, 'nenhuma transação aberta durante a chamada ao LLM');

      // A mensagem do contato já está gravada (a transação anterior foi confirmada).
      const stored = await messages.findByExternalId(company.id, 'nao-existe');
      assert.equal(stored, null);
      const recent = await conversations.list(company.id);
      assert.equal(recent.items.length, 1);
      assert.equal(
        (await messages.listRecent(company.id, recent.items[0]?.id ?? '', 10)).length,
        1,
      );
    } finally {
      release();
    }
    const result = await pending;
    assert.equal(result.reply.isFallback, false);
  });

  it('controle da checagem anterior: uma transação aberta de verdade é detectada pela mesma consulta', async () => {
    const company = await companyWithPersona('att-ctl');
    let detected = 0n;
    await runInTransaction(database.prisma, async (tx) => {
      // Abre a transação de fato (uma operação dentro dela) e consulta por outra conexão.
      await tx.conversation.count({ where: { companyId: company.id } });
      const open = await database.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND (state LIKE 'idle in transaction%' OR xact_start IS NOT NULL AND state = 'active')`;
      detected = open[0]?.total ?? 0n;
    });
    assert.ok(
      detected >= 1n,
      'a consulta enxerga a transação aberta (senão o teste acima seria vazio)',
    );
  });

  it('dois envios simultâneos com o mesmo externalId: uma única chamada ao LLM e uma única resposta', async () => {
    const company = await companyWithPersona('att-race');
    const input = { contactRef: 'contato-race', text: 'race-unico', externalId: 'ext-race' };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.handleInboundMessage(company.id, input)),
    );

    assert.equal(callsFor('race-unico').length, 1);
    const conversation = (await conversations.list(company.id)).items;
    assert.equal(conversation.length, 1);
    const stored = (await messages.listByConversation(company.id, conversation[0]?.id ?? '')).items;
    assert.equal(stored.filter((m) => m.role === 'USER').length, 1);
    assert.equal(stored.filter((m) => m.role === 'ASSISTANT').length, 1);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.filter((o) => !o.value.duplicate).length, 1);
    for (const o of fulfilled) assert.equal(o.value.reply.text, stored[1]?.content);
    for (const o of rejected) assert.ok(o.reason instanceof ConflictError, 'o outro recebe 409');
  });

  it('envios simultâneos do mesmo contato (sem externalId) usam uma única conversa', async () => {
    const company = await companyWithPersona('att-conv-race');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        service.handleInboundMessage(company.id, {
          contactRef: 'contato-novo',
          text: `conv-race-${String(i)}`,
        }),
      ),
    );
    assert.equal(new Set(results.map((r) => r.conversationId)).size, 1);
    assert.equal((await conversations.list(company.id)).items.length, 1);
    assert.equal(await messages.count(company.id), 12);
  });

  it('mensagem do contato sem resposta: recente dá 409; antiga é retomada e completa o fluxo', async () => {
    const company = await companyWithPersona('att-stale');
    const conversation = await conversations.findOrCreateByContact(company.id, 'contato-stale');

    // Recente (acabou de ser gravada): ainda "em andamento".
    await messages.create(company.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'stale-recente',
      externalId: 'ext-recente',
    });
    await assert.rejects(
      service.handleInboundMessage(company.id, {
        contactRef: 'contato-stale',
        text: 'stale-recente',
        externalId: 'ext-recente',
      }),
      ConflictError,
    );
    assert.equal(callsFor('stale-recente').length, 0);

    // Antiga (o servidor caiu antes de responder): a retentativa gera a resposta que faltava.
    const orphan = await messages.create(company.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'stale-antiga',
      externalId: 'ext-antiga',
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    const result = await service.handleInboundMessage(company.id, {
      contactRef: 'contato-stale',
      text: 'stale-antiga',
      externalId: 'ext-antiga',
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.messageId, orphan.id);
    assert.equal(callsFor('stale-antiga').length, 1);
    assert.equal((await messages.findReplyTo(company.id, orphan.id))?.id, result.reply.id);

    const again = await service.handleInboundMessage(company.id, {
      contactRef: 'contato-stale',
      text: 'stale-antiga',
      externalId: 'ext-antiga',
    });
    assert.equal(again.duplicate, true);
    assert.equal(callsFor('stale-antiga').length, 1);
  });

  it('empresa removida ou suspenso: 404/403 e nada é gravado', async () => {
    const removed = await companyWithPersona('att-removed');
    await companies.delete(removed.id);
    const suspended = await companyWithPersona('att-suspended');
    await companies.update(suspended.id, { status: 'SUSPENDED' });

    await assert.rejects(
      service.handleInboundMessage(removed.id, { contactRef: 'c', text: 'nada-removido' }),
      NotFoundError,
    );
    await assert.rejects(
      service.handleInboundMessage(suspended.id, { contactRef: 'c', text: 'nada-suspenso' }),
      ForbiddenError,
    );
    for (const company of [removed, suspended]) {
      assert.equal(await conversations.count(company.id), 0);
      assert.equal(await messages.count(company.id), 0);
    }
    assert.equal(callsFor('nada-').length, 0);
  });
});

describe('isolamento do atendimento entre empresas (A e B, mesmo contactRef e mesmo externalId)', () => {
  let a: Company;
  let b: Company;
  const resultsA: { conversationId: string; replyId: string }[] = [];
  const resultsB: { conversationId: string; replyId: string }[] = [];

  before(async () => {
    a = await companyWithPersona('iso-att-a', 'Persona-Alfa-ISO');
    b = await companyWithPersona('iso-att-b', 'Persona-Beta-ISO');
    // Conversas intercaladas, com os mesmos contactRef e externalId nas duas empresas.
    for (let i = 0; i < 4; i++) {
      const ra = await service.handleInboundMessage(a.id, {
        contactRef: 'contato-comum',
        text: `isoA-${String(i)}`,
        externalId: `ext-${String(i)}`,
      });
      const rb = await service.handleInboundMessage(b.id, {
        contactRef: 'contato-comum',
        text: `isoB-${String(i)}`,
        externalId: `ext-${String(i)}`,
      });
      resultsA.push({ conversationId: ra.conversationId, replyId: ra.reply.id });
      resultsB.push({ conversationId: rb.conversationId, replyId: rb.reply.id });
    }
  });

  it('conversas distintas e mensagens de um nunca aparecem no histórico nem na listagem do outro', async () => {
    assert.notEqual(resultsA[0]?.conversationId, resultsB[0]?.conversationId);
    const historyA = (await messages.listByConversation(a.id, resultsA[0]?.conversationId ?? ''))
      .items;
    const historyB = (await messages.listByConversation(b.id, resultsB[0]?.conversationId ?? ''))
      .items;
    assert.equal(historyA.length, 8);
    assert.equal(historyB.length, 8);
    assert.ok(historyA.every((m) => m.companyId === a.id && !m.content.includes('isoB')));
    assert.ok(historyB.every((m) => m.companyId === b.id && !m.content.includes('isoA')));
    assert.deepEqual(
      (await conversations.list(a.id)).items.map((c) => c.id),
      [resultsA[0]?.conversationId],
    );
    // O conversationId de B com o CompanyId de A: 404.
    await assert.rejects(
      service.listMessages(a.id, resultsB[0]?.conversationId ?? ''),
      NotFoundError,
    );
  });

  it('o histórico enviado ao LLM de A nunca contém mensagens de B (e vice-versa)', () => {
    const callsA = callsFor('isoA-');
    const callsB = callsFor('isoB-');
    assert.equal(callsA.length, 4);
    assert.equal(callsB.length, 4);
    for (const call of callsA) {
      assert.ok(call.history.every((turn) => !turn.content.includes('isoB')));
      assert.ok(call.history.every((turn) => !turn.content.includes('Persona-Beta-ISO')));
    }
    for (const call of callsB) {
      assert.ok(call.history.every((turn) => !turn.content.includes('isoA')));
      assert.ok(call.history.every((turn) => !turn.content.includes('Persona-Alfa-ISO')));
    }
    assert.equal(callsA[3]?.history.length, 6);
    assert.equal(callsB[3]?.history.length, 6);
  });

  it('a persona de um nunca é usada no outro', () => {
    assert.equal(callsFor('isoA-').length, 4);
    assert.equal(callsFor('isoB-').length, 4);
    assert.ok(
      callsFor('isoA-').every((call) => call.systemPrompt === withStyle('Persona-Alfa-ISO')),
    );
    assert.ok(
      callsFor('isoB-').every((call) => call.systemPrompt === withStyle('Persona-Beta-ISO')),
    );
  });

  it('o mesmo externalId em empresas diferentes não colide nem devolve a resposta do outro', async () => {
    const againA = await service.handleInboundMessage(a.id, {
      contactRef: 'contato-comum',
      text: 'isoA-0',
      externalId: 'ext-0',
    });
    const againB = await service.handleInboundMessage(b.id, {
      contactRef: 'contato-comum',
      text: 'isoB-0',
      externalId: 'ext-0',
    });
    assert.equal(againA.duplicate, true);
    assert.equal(againB.duplicate, true);
    assert.equal(againA.reply.id, resultsA[0]?.replyId);
    assert.equal(againB.reply.id, resultsB[0]?.replyId);
    assert.notEqual(againA.reply.id, againB.reply.id);
    assert.match(againA.reply.text, /isoA-0/);
    assert.match(againB.reply.text, /isoB-0/);
    assert.equal(
      callsFor('isoA-').length + callsFor('isoB-').length,
      8,
      'nenhuma chamada nova ao LLM',
    );
  });

  it('pedidos simultâneos das duas empresas não misturam contexto', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => [
        service.handleInboundMessage(a.id, {
          contactRef: 'contato-conc',
          text: `concA-${String(i)}`,
        }),
        service.handleInboundMessage(b.id, {
          contactRef: 'contato-conc',
          text: `concB-${String(i)}`,
        }),
      ]).flat(),
    );
    assert.equal(callsFor('concA-').length, 6);
    assert.equal(callsFor('concB-').length, 6);
    assert.ok(
      callsFor('concA-').some((call) => call.history.length > 0),
      'há histórico (não é vácuo)',
    );
    assert.ok(
      callsFor('concB-').some((call) => call.history.length > 0),
      'há histórico (não é vácuo)',
    );
    for (const call of callsFor('concA-')) {
      assert.equal(call.systemPrompt, withStyle('Persona-Alfa-ISO'));
      assert.ok(call.history.every((turn) => !turn.content.includes('concB')));
    }
    for (const call of callsFor('concB-')) {
      assert.equal(call.systemPrompt, withStyle('Persona-Beta-ISO'));
      assert.ok(call.history.every((turn) => !turn.content.includes('concA')));
    }
  });
});

describe('pedido de atendimento humano contra o PostgreSQL (spec 030)', () => {
  const notificationsOf = (companyId: string) =>
    database.prisma.notification.findMany({ where: { companyId } });

  it('simulador: a notificação é gravada com a resposta (mesma transação); externalId repetido não grava outra', async () => {
    const company = await companyWithPersona('att-handoff');
    const input = { contactRef: 'contato-humano', text: 'quero um atendente', externalId: 'h-1' };
    const result = await service.handleInboundMessage(company.id, input);
    const rows = await notificationsOf(company.id);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.messageId, result.reply.id);
    assert.equal(row.conversationId, result.conversationId);
    assert.equal(row.reason, 'CONTACT_REQUESTED');
    assert.equal(row.status, 'OPEN');
    const again = await service.handleInboundMessage(company.id, input);
    assert.equal(again.duplicate, true);
    assert.equal((await notificationsOf(company.id)).length, 1);
  });

  it('canal: se a transação da resposta desfaz depois de gravar a notificação, nada sobra no banco', async () => {
    const company = await companyWithPersona('att-handoff-rb');
    const real = new PrismaAttendanceUnitOfWork(database.prisma);
    // Mesma unidade de trabalho real; só a notificação falha DEPOIS de gravar, dentro da transação.
    const failing: AttendanceUnitOfWork = {
      run: (fn) =>
        real.run((tx) => {
          const createHandoff: AttendanceTransaction['notifications']['createHandoff'] = async (
            ...args
          ) => {
            await tx.notifications.createHandoff(...args);
            throw new ConflictError('falha simulada depois da notificação');
          };
          const wrapped: AttendanceTransaction = {
            ...tx,
            // Herda os demais métodos do repositório da transação (protótipo), troca só este.
            notifications: Object.assign(
              Object.create(tx.notifications) as AttendanceTransaction['notifications'],
              { createHandoff },
            ),
          };
          return fn(wrapped);
        }),
    };
    const local = new AttendanceService({
      companies,
      conversations,
      messages,
      unitOfWork: failing,
      llm,
      logger: logs.logger,
      options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000 },
    });
    await local.acceptInboundMessage(company.id, {
      contactRef: 'c-rb',
      text: 'atendente por favor',
    });
    await assert.rejects(
      local.respondToPending(company.id, 'c-rb', { maxMessages: 10, maxChars: 8_000 }),
      ConflictError,
    );
    assert.equal((await notificationsOf(company.id)).length, 0);
    const conversation = await conversations.findByContact(company.id, 'c-rb');
    assert.ok(conversation);
    const stored = (await messages.listByConversation(company.id, conversation.id)).items;
    assert.deepEqual(
      stored.map((message) => message.role),
      ['USER'],
      'a resposta também foi desfeita',
    );
  });
});
