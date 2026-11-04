import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import { buildQuery } from '../../application/knowledge/query.js';
import {
  type Company,
  KNOWLEDGE_MAX_PASSAGES,
  type Membership,
  type NewKnowledgeChunk,
} from '../../domain/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaKnowledgeDocumentRepository } from './repositories/knowledge-document.repository.js';
import { PrismaKnowledgeRetriever } from './repositories/knowledge-retriever.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let documents: PrismaKnowledgeDocumentRepository;
let retriever: PrismaKnowledgeRetriever;
let service: KnowledgeService;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
let ownerB: Membership;
let sql: pg.Client;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  documents = new PrismaKnowledgeDocumentRepository(database.prisma);
  retriever = new PrismaKnowledgeRetriever(database.prisma);
  service = new KnowledgeService(documents);
  const memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('kn-a');
  companyB = await tenants.createCompany('kn-b');
  ownerA = await memberships.create(companyA.id, {
    email: email('a'),
    passwordHash: HASH,
    role: 'OWNER',
  });
  ownerB = await memberships.create(companyB.id, {
    email: email('b'),
    passwordHash: HASH,
    role: 'OWNER',
  });
  sql = new pg.Client({ connectionString: config.DATABASE_URL });
  await sql.connect();

  // As duas empresas têm documentos de MESMO título e MESMAS palavras (isolamento).
  for (const [company, owner] of [
    [companyA, ownerA],
    [companyB, ownerB],
  ] as const) {
    await service.create(company.id, owner.id, {
      title: 'Política de trocas',
      content:
        'Aceitamos devoluções em até 7 dias.\n\nO prazo de troca começa na data da compra. Camiseta azul e camiseta verde.',
    });
  }
  await service.create(companyA.id, ownerA.id, {
    title: 'Horários',
    content: 'Abrimos de segunda a sábado, das 9h às 18h. A loja fecha aos domingos.',
  });
  await service.create(companyA.id, ownerA.id, {
    title: 'Pagamento',
    content: 'Aceitamos Pix, cartão de crédito e débito. A loja não aceita cheque.',
  });
});

after(async () => {
  try {
    await sql.end();
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function search(company: Company, text: string) {
  const tsquery = buildQuery(text);
  assert.ok(tsquery !== null, `consulta útil: ${text}`);
  return retriever.retrieve(company.id, tsquery);
}

describe('busca textual em português (E1)', () => {
  it('plural e radical: "camisetas azuis" acha "camiseta azul"', async () => {
    const found = await search(companyA, 'camisetas azuis');
    assert.ok(found.passages.some((p) => p.content.includes('Camiseta azul')));
  });

  it('"devolução" acha "devoluções" e a consulta sem acento acha texto com acento', async () => {
    const withAccent = await search(companyA, 'devolução');
    const without = await search(companyA, 'devolucao');
    for (const found of [withAccent, without]) {
      assert.ok(found.passages.some((p) => p.content.includes('devoluções')));
    }
  });

  it('pergunta em linguagem natural com palavras vazias acha "prazo" e "troca"', async () => {
    const found = await search(companyA, 'qual é o prazo de troca de vocês?');
    assert.equal(found.passages[0]?.title, 'Política de trocas');
    assert.ok(found.passages[0].content.includes('prazo de troca'));
  });

  it('o texto devolvido ao modelo é o original, com acentos', async () => {
    const found = await search(companyA, 'horario sabado');
    assert.equal(found.passages[0]?.title, 'Horários');
    assert.ok(found.passages[0].content.includes('das 9h às 18h'));
  });

  it('ranking: o trecho com mais termos relevantes vem antes', async () => {
    const found = await search(companyA, 'pix cartão loja');
    assert.equal(found.passages[0]?.title, 'Pagamento');
  });

  it('palavras sem correspondência devolvem vazio, mas hasAnyKnowledge é verdadeiro', async () => {
    const found = await search(companyA, 'helicoptero submarino');
    assert.deepEqual(found.passages, []);
    assert.equal(found.hasAnyKnowledge, true);
  });

  it('respeita o teto de 4 trechos mesmo com uma palavra comum em todos', async () => {
    const company = await tenants.createCompany('kn-teto');
    const membership = await new PrismaMembershipRepository(database.prisma).create(company.id, {
      email: email('t'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    for (let index = 0; index < 8; index += 1) {
      await service.create(company.id, membership.id, {
        title: `Documento ${String(index)}`,
        content: `A loja informa o item ${String(index)}.`,
      });
    }
    const found = await search(company, 'loja');
    assert.ok(found.passages.length <= KNOWLEDGE_MAX_PASSAGES);
    assert.ok(found.passages.length > 0);
  });
});

describe('isolamento entre empresas (E1)', () => {
  it('mesmas palavras e mesmo título: cada empresa só recupera o que é seu', async () => {
    const docsA = (await documents.list(companyA.id)).items.map((d) => d.id);
    const docsB = (await documents.list(companyB.id)).items.map((d) => d.id);
    assert.equal(docsB.length, 1);
    const foundB = await search(companyB, 'devolução prazo troca camiseta');
    assert.ok(foundB.passages.length > 0);
    for (const passage of foundB.passages) {
      assert.ok(docsB.includes(passage.documentId));
      assert.ok(!docsA.includes(passage.documentId));
    }
    // A B não enxerga o "Horários" da A.
    const horarios = await search(companyB, 'horario sabado domingo');
    assert.deepEqual(horarios.passages, []);
  });

  it('hasAnyKnowledge da empresa sem nada não enxerga a base de outra', async () => {
    const empty = await tenants.createCompany('kn-vazia');
    const found = await retriever.retrieve(empty.id, 'troca');
    assert.deepEqual(found.passages, []);
    assert.equal(found.hasAnyKnowledge, false);
  });

  it('listar e apagar com id de outra empresa: lista só a própria e 404 igual a inexistente', async () => {
    const [docB] = (await documents.list(companyB.id)).items;
    assert.ok(docB !== undefined);
    await assert.rejects(documents.delete(companyA.id, docB.id), NotFoundError);
    await assert.rejects(documents.delete(companyA.id, randomUUID()), NotFoundError);
    await assert.rejects(documents.delete(companyA.id, 'nao-e-uuid'), NotFoundError);
    assert.equal((await documents.list(companyB.id)).items.length, 1);
    for (const doc of (await documents.list(companyA.id)).items) {
      assert.equal(doc.companyId, companyA.id);
    }
  });

  it('o cursor de uma empresa não vaza a outra (paginação por empresa)', async () => {
    const page = await documents.list(companyA.id, { limit: 1 });
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor !== null);
    const next = await documents.list(companyA.id, { limit: 5, cursor: page.nextCursor });
    assert.ok(next.items.every((doc) => doc.companyId === companyA.id));
    const other = await documents.list(companyB.id, { limit: 5, cursor: page.nextCursor });
    assert.ok(other.items.every((doc) => doc.companyId === companyB.id));
  });

  it('o banco recusa trecho ligado a documento de outra empresa (FK composta)', async () => {
    const [docB] = (await documents.list(companyB.id)).items;
    assert.ok(docB !== undefined);
    await assert.rejects(
      sql.query(
        `INSERT INTO knowledge_chunks (id, company_id, document_id, position, content, search_text)
         VALUES ($1, $2, $3, 99, 'x', 'x')`,
        [randomUUID(), companyA.id, docB.id],
      ),
      /foreign key|chave estrangeira/,
    );
    // E o autor de outra empresa também é recusado.
    await assert.rejects(
      sql.query(
        `INSERT INTO knowledge_documents (id, company_id, title, char_count, chunk_count, preview, created_by_membership_id)
         VALUES ($1, $2, 't', 1, 1, 'p', $3)`,
        [randomUUID(), companyA.id, ownerB.id],
      ),
      /foreign key|chave estrangeira/,
    );
  });
});

describe('documento: transação, cascata e limites (E1)', () => {
  it('apagar o documento apaga os trechos (cascata), sem órfão', async () => {
    const doc = await service.create(companyA.id, ownerA.id, {
      title: 'Descartável',
      content: `${'a'.repeat(700)}\n\n${'b'.repeat(700)}`,
    });
    assert.equal(doc.chunkCount, 2);
    const before = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM knowledge_chunks WHERE document_id = $1',
      [doc.id],
    );
    assert.equal(before.rows[0]?.count, '2');
    await service.delete(companyA.id, doc.id);
    const after = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM knowledge_chunks WHERE document_id = $1',
      [doc.id],
    );
    assert.equal(after.rows[0]?.count, '0');
  });

  it('falha ao gravar um trecho desfaz o documento (nada pela metade)', async () => {
    const bad: NewKnowledgeChunk[] = [
      { content: 'ok', searchText: 'ok' },
      // search_text vazio viola o CHECK do banco.
      { content: 'ruim', searchText: '' },
    ];
    const before = await documents.countDocuments(companyA.id);
    await assert.rejects(
      documents.createWithChunks(
        companyA.id,
        {
          title: 'Quebrado',
          charCount: 6,
          preview: 'ok',
          isSample: false,
          createdByMembershipId: ownerA.id,
        },
        bad,
      ),
    );
    assert.equal(await documents.countDocuments(companyA.id), before);
  });

  it('documento apagado durante o atendimento: o seguinte não o recupera', async () => {
    const doc = await service.create(companyA.id, ownerA.id, {
      title: 'Efêmero',
      content: 'A promoção relâmpago termina hoje.',
    });
    const first = await search(companyA, 'promoção relâmpago');
    assert.ok(first.passages.some((p) => p.documentId === doc.id));
    await service.delete(companyA.id, doc.id);
    const second = await search(companyA, 'promoção relâmpago');
    assert.ok(!second.passages.some((p) => p.documentId === doc.id));
  });
});

describe('índice GIN (E1)', () => {
  it('a consulta de recuperação usa o índice de expressão com a tabela populada', async () => {
    const company = await tenants.createCompany('kn-gin');
    const membership = await new PrismaMembershipRepository(database.prisma).create(company.id, {
      email: email('g'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    const doc = await service.create(company.id, membership.id, {
      title: 'Base',
      content: 'texto',
    });
    await sql.query(
      `INSERT INTO knowledge_chunks (id, company_id, document_id, position, content, search_text)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, g, 'conteudo ' || g,
              'palavra' || g || ' comum' || (g % 50) || ' lorem ipsum dolor sit amet ' || g
         FROM generate_series(1, 6000) g`,
      [company.id, doc.id],
    );
    await sql.query('ANALYZE knowledge_chunks');
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT c.id, ts_rank_cd(to_tsvector('portuguese'::regconfig, c.search_text),
                                     to_tsquery('portuguese'::regconfig, $1))
         FROM knowledge_chunks c
        WHERE c.company_id = $2::uuid
          AND to_tsvector('portuguese'::regconfig, c.search_text)
              @@ to_tsquery('portuguese'::regconfig, $1)`,
      ['palavra4321', company.id],
    );
    const text = plan.rows.map((row) => Object.values(row)[0]).join('\n');
    assert.match(text, /Bitmap Index Scan on knowledge_chunks_search_idx/);
    // Limpa os 6.000 trechos criados por SQL direto (o cleanup do fixture também os removeria).
    await sql.query('DELETE FROM knowledge_chunks WHERE company_id = $1', [company.id]);
  });
});
