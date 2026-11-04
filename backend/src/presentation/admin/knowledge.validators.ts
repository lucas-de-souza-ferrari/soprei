import { z } from 'zod';
import { KNOWLEDGE_CONTENT_MAX_LENGTH, KNOWLEDGE_TITLE_MAX_LENGTH } from '../../domain/index.js';
import { companyIdSchema } from './company.validators.js';

/**
 * Corpo de `POST /admin/companies/:companyId/knowledge/documents` (spec 026): só `title` e `content`.
 * O teto de tamanho do texto é conferido pelo service com o código `KNOWLEDGE_DOCUMENT_TOO_LARGE`;
 * aqui só se barra o absurdo (o Fastify já limita o corpo). Nunca ecoa o valor.
 */
export const createDocumentBodySchema = z
  .object({
    title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX_LENGTH),
    content: z
      .string()
      .min(1)
      .max(KNOWLEDGE_CONTENT_MAX_LENGTH * 4),
  })
  .strict();

/** `:documentId` malformado, inexistente e de outra empresa são o mesmo 404 (o repositório decide). */
export const documentParamsSchema = z.object({
  companyId: companyIdSchema,
  documentId: z.string(),
});
