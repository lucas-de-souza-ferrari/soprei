import type { ListOptions, Page } from '../pagination.js';
import type { ClientId } from '../value-objects/client-id.js';

/** Os tipos de criação e de atualização nunca carregam `clientId`: ele vem do parâmetro. */
export interface WithoutClientId {
  readonly clientId?: never;
}

/**
 * Repositório de uma entidade que pertence a um cliente. O `ClientId` é o **primeiro
 * parâmetro de todo método**: não existe como consultar sem informar o cliente, e um id
 * de outro cliente se comporta como inexistente (`NotFoundError`).
 *
 * A ordem da listagem é estável: `createdAt` e depois `id`, ambos crescentes.
 */
export interface TenantRepository<
  T,
  TCreate extends WithoutClientId,
  TUpdate extends WithoutClientId,
> {
  /** Lança `NotFoundError` se o id não existe neste cliente. */
  findById(clientId: ClientId, id: string): Promise<T>;
  list(clientId: ClientId, options?: ListOptions): Promise<Page<T>>;
  create(clientId: ClientId, data: TCreate): Promise<T>;
  /** Lança `NotFoundError` se o id não existe neste cliente. */
  update(clientId: ClientId, id: string, data: TUpdate): Promise<T>;
  /** Lança `NotFoundError` se o id não existe neste cliente. */
  delete(clientId: ClientId, id: string): Promise<void>;
  count(clientId: ClientId): Promise<number>;
}
