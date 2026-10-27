import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import {
  ATTENDANCE_FALLBACK_TEXT,
  AttendanceService,
} from '../../application/attendance.service.js';
import type { Client } from '../../domain/index.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { MOCK_FAIL_MARKER, MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { createLogger } from '../logger/logger.js';
import { PrismaAttendanceUnitOfWork } from './attendance-unit-of-work.js';
import { PrismaClientRepository } from './client.repository.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { createDatabase, type Database } from './database.js';
import { PrismaMessageRepository } from './message.repository.js';
import { runInTransaction } from './transaction.js';

const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let clients: PrismaClientRepository;
let conversations: PrismaConversationRepository;
let messages: PrismaMessageRepository;
let llm: MockLlmProvider;
let service: AttendanceService;
const logs = captureLogs();

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  clients = new PrismaClientRepository(database.prisma);
  conversations = new PrismaConversationRepository(database.prisma);
  messages = new PrismaMessageRepository(database.prisma);
  llm = new MockLlmProvider({ recordCalls: true });
  service = new AttendanceService({
    clients,
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

async function clientWithPersona(label: string, persona?: string): Promise<Client> {
  const client = await tenants.createClient(label);
  return persona === undefined ? client : clients.update(client.id, { persona });
}

/** Chamadas ao LLM cujo `userMessage` começa com `prefix` (isola testes que compartilham o mock). */
const callsFor = (prefix: string) =>
  llm.calls.filter((call) => call.userMessage.startsWith(prefix));

describe('atendimento contra o PostgreSQL de testes', () => {
  it('pipeline completo: conversa por contactRef, mensagem do contato e resposta gravadas', async () => {
    const client = await clientWithPersona('att-e2e', 'Persona-E2E');
    const first = await service.handleInboundMessage(client.id, {
      contactRef: 'contato-e2e',
      text: 'e2e-um',
    });
    const second = await service.handleInboundMessage(client.id, {
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

    const stored = (await messages.listByConversation(client.id, first.conversationId)).items;
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
    assert.equal(call?.systemPrompt, 'Persona-E2E');
    assert.deepEqual(
      call.history.map((turn) => turn.role),
      ['user', 'assistant'],
    );
  });

  it('falha do provider: o fallback é gravado com isFallback = true no banco', async () => {
    const client = await clientWithPersona('att-fb');
    const result = await service.handleInboundMessage(client.id, {
      contactRef: 'contato-fb',
      text: `fb ${MOCK_FAIL_MARKER}`,
    });
    assert.equal(result.reply.text, ATTENDANCE_FALLBACK_TEXT);
    assert.equal(result.reply.isFallback, true);
    const stored = await messages.findById(client.id, result.reply.id);
    assert.equal(stored.isFallback, true);
    assert.equal(stored.content, ATTENDANCE_FALLBACK_TEXT);
    assert.equal(stored.replyToId, result.messageId);
  });

  it('a chamada ao LLM fica fora da transação: com o provider bloqueado, nenhuma transação está aberta', async () => {
    const client = await clientWithPersona('att-tx');
    const release = llm.hold();
    const before = llm.calls.length;
    const pending = service.handleInboundMessage(client.id, {
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
      const stored = await messages.findByExternalId(client.id, 'nao-existe');
      assert.equal(stored, null);
      const recent = await conversations.list(client.id);
      assert.equal(recent.items.length, 1);
      assert.equal((await messages.listRecent(client.id, recent.items[0]?.id ?? '', 10)).length, 1);
    } finally {
      release();
    }
    const result = await pending;
    assert.equal(result.reply.isFallback, false);
  });

  it('controle da checagem anterior: uma transação aberta de verdade é detectada pela mesma consulta', async () => {
    const client = await clientWithPersona('att-ctl');
    let detected = 0n;
    await runInTransaction(database.prisma, async (tx) => {
      // Abre a transação de fato (uma operação dentro dela) e consulta por outra conexão.
      await tx.conversation.count({ where: { clientId: client.id } });
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
    const client = await clientWithPersona('att-race');
    const input = { contactRef: 'contato-race', text: 'race-unico', externalId: 'ext-race' };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.handleInboundMessage(client.id, input)),
    );

    assert.equal(callsFor('race-unico').length, 1);
    const conversation = (await conversations.list(client.id)).items;
    assert.equal(conversation.length, 1);
    const stored = (await messages.listByConversation(client.id, conversation[0]?.id ?? '')).items;
    assert.equal(stored.filter((m) => m.role === 'USER').length, 1);
    assert.equal(stored.filter((m) => m.role === 'ASSISTANT').length, 1);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.filter((o) => !o.value.duplicate).length, 1);
    for (const o of fulfilled) assert.equal(o.value.reply.text, stored[1]?.content);
    for (const o of rejected) assert.ok(o.reason instanceof ConflictError, 'o outro recebe 409');
  });

  it('envios simultâneos do mesmo contato (sem externalId) usam uma única conversa', async () => {
    const client = await clientWithPersona('att-conv-race');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        service.handleInboundMessage(client.id, {
          contactRef: 'contato-novo',
          text: `conv-race-${String(i)}`,
        }),
      ),
    );
    assert.equal(new Set(results.map((r) => r.conversationId)).size, 1);
    assert.equal((await conversations.list(client.id)).items.length, 1);
    assert.equal(await messages.count(client.id), 12);
  });

  it('mensagem do contato sem resposta: recente dá 409; antiga é retomada e completa o fluxo', async () => {
    const client = await clientWithPersona('att-stale');
    const conversation = await conversations.findOrCreateByContact(client.id, 'contato-stale');

    // Recente (acabou de ser gravada): ainda "em andamento".
    await messages.create(client.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'stale-recente',
      externalId: 'ext-recente',
    });
    await assert.rejects(
      service.handleInboundMessage(client.id, {
        contactRef: 'contato-stale',
        text: 'stale-recente',
        externalId: 'ext-recente',
      }),
      ConflictError,
    );
    assert.equal(callsFor('stale-recente').length, 0);

    // Antiga (o servidor caiu antes de responder): a retentativa gera a resposta que faltava.
    const orphan = await messages.create(client.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'stale-antiga',
      externalId: 'ext-antiga',
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    const result = await service.handleInboundMessage(client.id, {
      contactRef: 'contato-stale',
      text: 'stale-antiga',
      externalId: 'ext-antiga',
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.messageId, orphan.id);
    assert.equal(callsFor('stale-antiga').length, 1);
    assert.equal((await messages.findReplyTo(client.id, orphan.id))?.id, result.reply.id);

    const again = await service.handleInboundMessage(client.id, {
      contactRef: 'contato-stale',
      text: 'stale-antiga',
      externalId: 'ext-antiga',
    });
    assert.equal(again.duplicate, true);
    assert.equal(callsFor('stale-antiga').length, 1);
  });

  it('cliente removido ou suspenso: 404/403 e nada é gravado', async () => {
    const removed = await clientWithPersona('att-removed');
    await clients.delete(removed.id);
    const suspended = await clientWithPersona('att-suspended');
    await clients.update(suspended.id, { status: 'SUSPENDED' });

    await assert.rejects(
      service.handleInboundMessage(removed.id, { contactRef: 'c', text: 'nada-removido' }),
      NotFoundError,
    );
    await assert.rejects(
      service.handleInboundMessage(suspended.id, { contactRef: 'c', text: 'nada-suspenso' }),
      ForbiddenError,
    );
    for (const client of [removed, suspended]) {
      assert.equal(await conversations.count(client.id), 0);
      assert.equal(await messages.count(client.id), 0);
    }
    assert.equal(callsFor('nada-').length, 0);
  });
});

describe('isolamento do atendimento entre clientes (A e B, mesmo contactRef e mesmo externalId)', () => {
  let a: Client;
  let b: Client;
  const resultsA: { conversationId: string; replyId: string }[] = [];
  const resultsB: { conversationId: string; replyId: string }[] = [];

  before(async () => {
    a = await clientWithPersona('iso-att-a', 'Persona-Alfa-ISO');
    b = await clientWithPersona('iso-att-b', 'Persona-Beta-ISO');
    // Conversas intercaladas, com os mesmos contactRef e externalId nos dois clientes.
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
    assert.ok(historyA.every((m) => m.clientId === a.id && !m.content.includes('isoB')));
    assert.ok(historyB.every((m) => m.clientId === b.id && !m.content.includes('isoA')));
    assert.deepEqual(
      (await conversations.list(a.id)).items.map((c) => c.id),
      [resultsA[0]?.conversationId],
    );
    // O conversationId de B com o ClientId de A: 404.
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
    assert.ok(callsFor('isoA-').every((call) => call.systemPrompt === 'Persona-Alfa-ISO'));
    assert.ok(callsFor('isoB-').every((call) => call.systemPrompt === 'Persona-Beta-ISO'));
  });

  it('o mesmo externalId em clientes diferentes não colide nem devolve a resposta do outro', async () => {
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

  it('pedidos simultâneos dos dois clientes não misturam contexto', async () => {
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
    for (const call of callsFor('concA-')) {
      assert.equal(call.systemPrompt, 'Persona-Alfa-ISO');
      assert.ok(call.history.every((turn) => !turn.content.includes('concB')));
    }
    for (const call of callsFor('concB-')) {
      assert.equal(call.systemPrompt, 'Persona-Beta-ISO');
      assert.ok(call.history.every((turn) => !turn.content.includes('concA')));
    }
  });
});
