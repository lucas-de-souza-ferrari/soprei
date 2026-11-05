import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { InventoryService } from '../../application/inventory/inventory.service.js';
import {
  adjustmentSchema,
  importBodySchema,
  productInputSchema,
  productPatchSchema,
  searchSchema,
} from '../../application/inventory/inventory.schemas.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { Product, StockMovement } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, membershipAuth, requirePermission } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { companyIdSchema } from './company.validators.js';
import { toListOptions } from './list-options.js';

export interface AdminInventoryControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly inventory: Pick<
    InventoryService,
    'list' | 'create' | 'update' | 'adjust' | 'movements' | 'importRows'
  >;
}

/** `:productId` malformado, inexistente e de outra empresa são o mesmo 404 (o repositório decide). */
const productParamsSchema = z.object({ companyId: companyIdSchema, productId: z.string() });
const productsQuerySchema = listQuerySchema.extend({ q: searchSchema.optional() });

function toProductResponse(product: Product): {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  quantity: number;
  lowStockThreshold: number;
  active: boolean;
  isSample: boolean;
  updatedAt: string;
} {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    quantity: product.quantity,
    lowStockThreshold: product.lowStockThreshold,
    active: product.active,
    isSample: product.isSample,
    updatedAt: product.updatedAt.toISOString(),
  };
}

/** Movimento para o navegador: o id do vínculo não sai, só se foi quem está logado (`byMe`). */
function toMovementResponse(
  movement: StockMovement,
  membershipId: string,
): {
  id: string;
  delta: number;
  quantityAfter: number;
  reason: string;
  createdAt: string;
  byMe: boolean;
} {
  return {
    id: movement.id,
    delta: movement.delta,
    quantityAfter: movement.quantityAfter,
    reason: movement.reason,
    createdAt: movement.createdAt.toISOString(),
    byMe: movement.createdByMembershipId === membershipId,
  };
}

/**
 * Estoque da própria empresa (spec 026, E2). Registre com `prefix: '/admin/companies'`. O `:companyId`
 * do caminho é conferido contra a identidade pelo `requirePermission` (404 antes de 403) e descartado:
 * o service recebe só o `CompanyId` da identidade. SKU, nome, descrição e preço são dado da empresa:
 * **nunca** vão a log nem a métrica (só ids e a ação). Quantidade só muda em `adjustments`.
 */
export const adminInventoryController: FastifyPluginCallback<AdminInventoryControllerOptions> = (
  app,
  { auth, metrics, inventory },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const onRequest = requirePermission('inventory:manage', { companyParam: 'companyId', metrics });

  app.get('/:companyId/inventory/products', { config, onRequest }, async (request) => {
    const { companyId } = membershipAuth(request);
    const { q, ...page } = productsQuerySchema.parse(request.query);
    const result = await inventory.list(companyId, { ...toListOptions(page), search: q });
    return { items: result.items.map(toProductResponse), nextCursor: result.nextCursor };
  });

  app.post('/:companyId/inventory/products', { config, onRequest }, async (request, reply) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = productInputSchema.parse(request.body);
    const product = await inventory.create(companyId, membershipId, body);
    request.log.info(
      { companyId, membershipId, productId: product.id },
      'produto do estoque criado',
    );
    return reply.status(201).send(toProductResponse(product));
  });

  app.post('/:companyId/inventory/products/import', { config, onRequest }, async (request) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = importBodySchema.parse(request.body);
    const result = await inventory.importRows(companyId, membershipId, body.rows);
    request.log.info(
      { companyId, membershipId, created: result.created, skipped: result.skipped.length },
      'importação de produtos concluída',
    );
    return result;
  });

  app.patch('/:companyId/inventory/products/:productId', { config, onRequest }, async (request) => {
    const { productId } = productParamsSchema.parse(request.params);
    const { companyId, membershipId } = membershipAuth(request);
    const body = productPatchSchema.parse(request.body);
    const product = await inventory.update(companyId, productId, body);
    request.log.info({ companyId, membershipId, productId }, 'produto do estoque atualizado');
    return toProductResponse(product);
  });

  app.post(
    '/:companyId/inventory/products/:productId/adjustments',
    { config, onRequest },
    async (request) => {
      const { productId } = productParamsSchema.parse(request.params);
      const { companyId, membershipId } = membershipAuth(request);
      const body = adjustmentSchema.parse(request.body);
      const { product, movement } = await inventory.adjust(
        companyId,
        membershipId,
        productId,
        body,
      );
      request.log.info(
        { companyId, membershipId, productId, reason: body.reason },
        'estoque ajustado',
      );
      return {
        product: toProductResponse(product),
        movement: toMovementResponse(movement, membershipId),
      };
    },
  );

  app.get(
    '/:companyId/inventory/products/:productId/movements',
    { config, onRequest },
    async (request) => {
      const { productId } = productParamsSchema.parse(request.params);
      const { companyId, membershipId } = membershipAuth(request);
      const query = listQuerySchema.parse(request.query);
      const page = await inventory.movements(companyId, productId, toListOptions(query));
      return {
        items: page.items.map((movement) => toMovementResponse(movement, membershipId)),
        nextCursor: page.nextCursor,
      };
    },
  );

  done();
};
