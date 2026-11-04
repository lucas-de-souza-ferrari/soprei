import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type Company, CompanyId } from '../../../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { PrismaCompanyRepository } from './company.repository.js';
import { createDatabase, type Database } from '../database.js';
import { runInTransaction } from '../transaction.js';

const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let repo: PrismaCompanyRepository;

const slug = (label: string): string => `${label}-${randomBytes(6).toString('hex')}`;

async function createTracked(label: string): Promise<Company> {
  const company = await repo.create({ name: `Empresa ${label}`, slug: slug(label) });
  tenants.track(company.id);
  return company;
}

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  repo = new PrismaCompanyRepository(database.prisma);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

describe('repositório de Company (raiz do tenant)', () => {
  it('cria com status ACTIVE por padrão e devolve a entidade de domínio', async () => {
    const created = await createTracked('crud');
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.name, 'Empresa crud');
    assert.ok(created.createdAt instanceof Date);
    assert.equal(CompanyId.parse(created.id), created.id);
    assert.ok(!('deletedAt' in created));
  });

  it('cria com status informado', async () => {
    const created = await repo.create({
      name: 'Suspenso',
      slug: slug('susp'),
      status: 'SUSPENDED',
    });
    tenants.track(created.id);
    assert.equal(created.status, 'SUSPENDED');
  });

  it('busca por id e por slug', async () => {
    const created = await createTracked('busca');
    assert.deepEqual(await repo.findById(created.id), created);
    assert.deepEqual(await repo.findBySlug(created.slug), created);
    await assert.rejects(repo.findBySlug(slug('inexistente')), NotFoundError);
    await assert.rejects(
      repo.findById(CompanyId.parse('01890a5d-ac96-774b-bcce-b302099a8057')),
      NotFoundError,
    );
  });

  it('atualiza nome e status sem mexer no slug', async () => {
    const created = await createTracked('upd');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await repo.update(created.id, { name: 'Novo nome', status: 'SUSPENDED' });
    assert.equal(updated.name, 'Novo nome');
    assert.equal(updated.status, 'SUSPENDED');
    assert.equal(updated.slug, created.slug);
    assert.ok(updated.updatedAt.getTime() > created.updatedAt.getTime());

    const onlyName = await repo.update(created.id, { name: 'Só o nome' });
    assert.equal(onlyName.status, 'SUSPENDED');
  });

  it('slug duplicado é ConflictError, sem vazar a coluna ou o SQL', async () => {
    const created = await createTracked('dup');
    await assert.rejects(repo.create({ name: 'Outro', slug: created.slug }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.ok(!error.message.includes('slug'));
      assert.ok(!error.message.toLowerCase().includes('unique'));
      return true;
    });
  });

  it('dois pedidos simultâneos com o mesmo slug: um cria e o outro dá ConflictError', async () => {
    const shared = slug('race');
    const results = await Promise.allSettled([
      repo.create({ name: 'A', slug: shared }),
      repo.create({ name: 'B', slug: shared }),
      repo.create({ name: 'C', slug: shared }),
    ]);
    const created = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    for (const result of created) tenants.track(result.value.id);
    assert.equal(created.length, 1);
    assert.equal(failed.length, 2);
    assert.ok(failed.every((result) => result.reason instanceof ConflictError));
  });

  it('soft delete: some de buscas e listagens, a linha continua e o slug fica reservado', async () => {
    const created = await createTracked('soft');
    await repo.delete(created.id);

    await assert.rejects(repo.findById(created.id), NotFoundError);
    await assert.rejects(repo.findBySlug(created.slug), NotFoundError);
    await assert.rejects(repo.update(created.id, { name: 'x' }), NotFoundError);
    await assert.rejects(repo.delete(created.id), NotFoundError);

    const listedIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.list({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      listedIds.push(...page.items.map((company) => company.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.ok(!listedIds.includes(created.id));

    // A linha continua no banco (soft delete) e o slug não pode ser reutilizado.
    const row = await database.prisma.company.findFirst({ where: { id: created.id } });
    assert.ok(row?.deletedAt instanceof Date);
    await assert.rejects(repo.create({ name: 'Reuso', slug: created.slug }), ConflictError);
  });

  it('list pagina por cursor com ordem estável e valida limit e cursor', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, index) => createTracked(`pag${String(index)}`)),
    );
    const mine = new Set(created.map((company) => company.id));

    const seen: Company[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repo.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 200);

    const ids = seen.map((company) => company.id);
    assert.equal(new Set(ids).size, ids.length, 'sem repetição entre páginas');
    for (const id of mine) assert.ok(ids.includes(id));
    const sorted = [...seen].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1),
    );
    assert.deepEqual(
      seen.map((company) => company.id),
      sorted.map((company) => company.id),
    );

    await assert.rejects(repo.list({ limit: 0 }), ValidationError);
    await assert.rejects(repo.list({ limit: 201 }), ValidationError);
    await assert.rejects(repo.list({ cursor: 'invalido' }), ValidationError);
  });

  it('forTransaction: o rollback desfaz a criação da empresa', async () => {
    const wanted = slug('tx');
    const boom = new ValidationError('abortar');
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        await repo.forTransaction(tx).create({ name: 'Tx', slug: wanted });
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    await assert.rejects(repo.findBySlug(wanted), NotFoundError);
  });
});

describe('findByWhatsappPhoneNumberId (spec 011)', () => {
  /** Número único por execução (1 a 32 dígitos), para não colidir com dados de outros testes. */
  const phoneId = (): string => `9${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;

  it('devolve a empresa dona do número e null para número desconhecido', async () => {
    const number = phoneId();
    const company = await createTracked('wa-find');
    await repo.update(company.id, { whatsappPhoneNumberId: number });
    const found = await repo.findByWhatsappPhoneNumberId(number);
    assert.equal(found?.id, company.id);
    assert.equal(found.whatsappPhoneNumberId, number);
    assert.equal(await repo.findByWhatsappPhoneNumberId(phoneId()), null);
  });

  it('formato inválido nunca casa (e não vai ao banco): vazio, letras, mais de 32 dígitos, curinga', async () => {
    for (const invalid of ['', 'abc', '1'.repeat(33), '%', '12 3', "1' OR '1'='1"]) {
      assert.equal(await repo.findByWhatsappPhoneNumberId(invalid), null, invalid);
    }
  });

  it('não devolve empresa removida, e remover libera o número para outra empresa', async () => {
    const number = phoneId();
    const removed = await createTracked('wa-removed');
    await repo.update(removed.id, { whatsappPhoneNumberId: number });
    await repo.delete(removed.id);
    assert.equal(await repo.findByWhatsappPhoneNumberId(number), null);

    const next = await createTracked('wa-reuse');
    const updated = await repo.update(next.id, { whatsappPhoneNumberId: number });
    assert.equal(updated.whatsappPhoneNumberId, number);
    assert.equal((await repo.findByWhatsappPhoneNumberId(number))?.id, next.id);
  });

  it('mesmo se uma empresa removida ainda guardasse o número, ele não seria devolvido (filtro de removidos)', async () => {
    const number = phoneId();
    const company = await createTracked('wa-ghost');
    await repo.update(company.id, { whatsappPhoneNumberId: number });
    // Soft delete "à mão", sem liberar o número: o filtro do repositório é a barreira.
    await database.prisma.company.updateMany({
      where: { id: company.id },
      data: { deletedAt: new Date() },
    });
    assert.equal(await repo.findByWhatsappPhoneNumberId(number), null);
  });

  it('duas empresas não podem ter o mesmo número (ConflictError); null libera e vários podem não ter', async () => {
    const number = phoneId();
    const first = await createTracked('wa-dup-1');
    const second = await createTracked('wa-dup-2');
    await repo.update(first.id, { whatsappPhoneNumberId: number });
    await assert.rejects(
      repo.update(second.id, { whatsappPhoneNumberId: number }),
      (error: unknown) => error instanceof ConflictError,
    );
    assert.equal((await repo.findByWhatsappPhoneNumberId(number))?.id, first.id);

    const cleared = await repo.update(first.id, { whatsappPhoneNumberId: null });
    assert.equal(cleared.whatsappPhoneNumberId, null);
    assert.equal(await repo.findByWhatsappPhoneNumberId(number), null);
    // Várias empresas sem número convivem (NULL não colide).
    const third = await createTracked('wa-null-1');
    const fourth = await createTracked('wa-null-2');
    assert.equal(third.whatsappPhoneNumberId, null);
    assert.equal(fourth.whatsappPhoneNumberId, null);
  });

  it('SQL cru: o banco recusa número com formato inválido (CHECK)', async () => {
    const company = await createTracked('wa-check');
    for (const invalid of ['abc', '', '1'.repeat(33), '+5511999999999']) {
      await assert.rejects(
        database.prisma
          .$executeRaw`UPDATE companies SET whatsapp_phone_number_id = ${invalid} WHERE id = ${company.id}::uuid`,
        /format_check|check/i,
        invalid,
      );
    }
  });
});
