import type { FastifyPluginCallback } from 'fastify';
import type { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { KnowledgeDocument } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, membershipAuth, requirePermission } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { createDocumentBodySchema, documentParamsSchema } from './knowledge.validators.js';
import { toListOptions } from './list-options.js';

export interface AdminKnowledgeControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly knowledge: Pick<KnowledgeService, 'list' | 'create' | 'delete'>;
}

/** Documento para o navegador: tamanho, trechos e pré-visualização; nunca o texto inteiro. */
function toDocumentResponse(document: KnowledgeDocument): {
  id: string;
  title: string;
  charCount: number;
  chunkCount: number;
  preview: string;
  isSample: boolean;
  createdAt: string;
} {
  return {
    id: document.id,
    title: document.title,
    charCount: document.charCount,
    chunkCount: document.chunkCount,
    preview: document.preview,
    isSample: document.isSample,
    createdAt: document.createdAt.toISOString(),
  };
}

/**
 * Base de conhecimento da própria empresa (spec 026). Registre com `prefix: '/admin/companies'`. O
 * `:companyId` do caminho é conferido contra a identidade pelo `requirePermission` (404 antes de
 * 403) e descartado: o service recebe só o `CompanyId` da identidade. Título e texto são dado da
 * empresa (às vezes pessoal): **nunca** vão a log nem a métrica; só ids e a ação.
 */
export const adminKnowledgeController: FastifyPluginCallback<AdminKnowledgeControllerOptions> = (
  app,
  { auth, metrics, knowledge },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const onRequest = requirePermission('knowledge:manage', { companyParam: 'companyId', metrics });

  app.get('/:companyId/knowledge/documents', { config, onRequest }, async (request) => {
    const { companyId } = membershipAuth(request);
    const query = listQuerySchema.parse(request.query);
    const page = await knowledge.list(companyId, toListOptions(query));
    return { items: page.items.map(toDocumentResponse), nextCursor: page.nextCursor };
  });

  app.post('/:companyId/knowledge/documents', { config, onRequest }, async (request, reply) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = createDocumentBodySchema.parse(request.body);
    const document = await knowledge.create(companyId, membershipId, body);
    request.log.info(
      { companyId, membershipId, documentId: document.id, chunkCount: document.chunkCount },
      'documento da base de conhecimento criado',
    );
    return reply.status(201).send(toDocumentResponse(document));
  });

  app.delete(
    '/:companyId/knowledge/documents/:documentId',
    { config, onRequest },
    async (request, reply) => {
      const { documentId } = documentParamsSchema.parse(request.params);
      const { companyId, membershipId } = membershipAuth(request);
      await knowledge.delete(companyId, documentId);
      request.log.info(
        { companyId, membershipId, documentId },
        'documento da base de conhecimento apagado',
      );
      return reply.status(204).send();
    },
  );

  done();
};
