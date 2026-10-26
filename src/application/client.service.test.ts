import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { ClientId, type NewClient } from '../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors/index.js';
import { InMemoryClientRepository } from '../test-support/in-memory-client.repository.js';
import { ClientService } from './client.service.js';

let service: ClientService;

beforeEach(() => {
  service = new ClientService(new InMemoryClientRepository());
});

const input = (slug = 'acme-corp'): NewClient => ({ name: 'Acme Corp', slug });
const unknownId = (): ClientId => ClientId.parse(randomUUID());

describe('ClientService', () => {
  it('cria cliente ACTIVE por padrão, com nome aparado', async () => {
    const client = await service.create({ name: '  Acme Corp  ', slug: 'acme-corp' });
    assert.equal(client.name, 'Acme Corp');
    assert.equal(client.status, 'ACTIVE');
    assert.equal(client.slug, 'acme-corp');
  });

  it('busca por id e por slug', async () => {
    const created = await service.create(input());
    assert.deepEqual(await service.getById(created.id), created);
    assert.deepEqual(await service.getBySlug('acme-corp'), created);
    await assert.rejects(service.getById(unknownId()), NotFoundError);
    await assert.rejects(service.getBySlug('nao-existe'), NotFoundError);
    await assert.rejects(service.getBySlug('Inválido!'), ValidationError);
  });

  it('lista com paginação', async () => {
    for (const slug of ['aaa', 'bbb', 'ccc']) await service.create(input(slug));
    const first = await service.list({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor !== null);
    const second = await service.list({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
  });

  it('atualiza nome e status; o slug não muda', async () => {
    const created = await service.create(input());
    const updated = await service.update(created.id, { name: ' Novo ', status: 'SUSPENDED' });
    assert.equal(updated.name, 'Novo');
    assert.equal(updated.status, 'SUSPENDED');
    assert.equal(updated.slug, created.slug);
  });

  it('update sem nenhum campo é ValidationError; id inexistente é NotFoundError', async () => {
    const created = await service.create(input());
    await assert.rejects(service.update(created.id, {}), ValidationError);
    await assert.rejects(service.update(unknownId(), { name: 'x' }), NotFoundError);
  });

  it('remove por soft delete: some das buscas e o slug continua reservado', async () => {
    const created = await service.create(input());
    await service.remove(created.id);
    await assert.rejects(service.getById(created.id), NotFoundError);
    await assert.rejects(service.getBySlug(created.slug), NotFoundError);
    await assert.rejects(service.remove(created.id), NotFoundError);
    assert.deepEqual((await service.list()).items, []);
    await assert.rejects(service.create(input(created.slug)), ConflictError);
  });

  it('slug duplicado é ConflictError com mensagem sobre o slug', async () => {
    await service.create(input());
    await assert.rejects(service.create(input()), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /slug/);
      return true;
    });
  });

  it('valida nome, slug e status antes de chamar o repositório', async () => {
    await assert.rejects(service.create({ name: '   ', slug: 'valido' }), ValidationError);
    await assert.rejects(
      service.create({ name: 'x'.repeat(121), slug: 'valido' }),
      ValidationError,
    );
    for (const slug of [
      'ab',
      'a'.repeat(64),
      'Maiuscula',
      'com espaco',
      'com_underscore',
      'ação',
    ]) {
      await assert.rejects(service.create({ name: 'X', slug }), ValidationError, slug);
    }
    await assert.rejects(
      service.create({ name: 'X', slug: 'valido', status: 'DELETED' as never }),
      ValidationError,
    );
    assert.deepEqual((await service.list()).items, []);
  });

  it('aceita slug nos limites (3 e 63 caracteres)', async () => {
    assert.equal((await service.create({ name: 'X', slug: 'abc' })).slug, 'abc');
    assert.equal((await service.create({ name: 'X', slug: 'a'.repeat(63) })).slug.length, 63);
  });
});
