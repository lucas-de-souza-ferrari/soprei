import type { FastifyPluginCallback } from 'fastify';
import type { ClientService } from '../../application/client.service.js';
import type { Client } from '../../domain/index.js';
import { adminAuthHook } from './admin-auth.hook.js';
import {
  clientParamsSchema,
  createClientBodySchema,
  listClientsQuerySchema,
  updateClientBodySchema,
} from './client.validators.js';

export interface AdminClientsControllerOptions {
  /** `ADMIN_API_KEY`; ausente significa que toda requisição a /admin recebe 401. */
  readonly apiKey: string | undefined;
  readonly clients: ClientService;
}

/** Só campos seguros: nada de `deletedAt` nem de detalhe interno. */
function toResponse(client: Client): {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    status: client.status,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };
}

/**
 * Rotas administrativas `/admin/clients` (registre com `prefix: '/admin/clients'`).
 * Finas: autenticam, validam com Zod, chamam o service e deixam o erro subir ao handler
 * central.
 */
export const adminClientsController: FastifyPluginCallback<AdminClientsControllerOptions> = (
  app,
  { apiKey, clients },
  done,
) => {
  app.addHook('onRequest', adminAuthHook(apiKey));

  app.post('/', async (request, reply) => {
    const body = createClientBodySchema.parse(request.body);
    const client = await clients.create(body);
    request.log.info({ clientId: client.id, slug: client.slug }, 'cliente criado');
    return reply.status(201).send(toResponse(client));
  });

  app.get('/', async (request) => {
    const { limit, cursor } = listClientsQuerySchema.parse(request.query);
    const page = await clients.list({
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  });

  app.get('/:id', async (request) => {
    const { id } = clientParamsSchema.parse(request.params);
    return toResponse(await clients.getById(id));
  });

  app.patch('/:id', async (request) => {
    const { id } = clientParamsSchema.parse(request.params);
    const body = updateClientBodySchema.parse(request.body);
    const client = await clients.update(id, body);
    request.log.info({ clientId: client.id }, 'cliente atualizado');
    return toResponse(client);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = clientParamsSchema.parse(request.params);
    await clients.remove(id);
    request.log.info({ clientId: id }, 'cliente removido');
    return reply.status(204).send();
  });

  done();
};
