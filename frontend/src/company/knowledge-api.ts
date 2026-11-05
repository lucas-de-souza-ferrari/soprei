import { z } from 'zod';
import { ApiError, request } from '../api';

/**
 * Base de conhecimento da empresa (spec 026): contratos estritos e mensagens por `status` e
 * `error.code`. O texto de erro do servidor nunca é lido nem exibido. Título e texto dos documentos
 * vivem só em memória: nada vai a URL, armazenamento do navegador, título da página nem log.
 */
export const KNOWLEDGE_TITLE_MAX = 120;
export const KNOWLEDGE_CONTENT_MAX = 100_000;
/** Teto do arquivo lido no navegador (bytes), antes de ler. */
export const KNOWLEDGE_FILE_MAX_BYTES = 200 * 1024;
export const KNOWLEDGE_PAGE_SIZE = 50;

const isoDate = z.iso.datetime();
const cursorText = z.string().min(1).max(512);

export const documentSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().min(1).max(KNOWLEDGE_TITLE_MAX),
  charCount: z.number().int().min(1),
  chunkCount: z.number().int().min(1),
  preview: z.string().max(200),
  isSample: z.boolean(),
  createdAt: isoDate,
});
export type KnowledgeDocumentItem = z.infer<typeof documentSchema>;

export const documentsPageSchema = z.strictObject({
  items: z.array(documentSchema).max(200),
  nextCursor: cursorText.nullable(),
});

const companyPath = (companyId: string): string => `/admin/companies/${companyId}`;

const sampleLoadSchema = z.strictObject({ created: z.boolean() });
const sampleRemoveSchema = z.strictObject({
  documents: z.number().int().min(0),
  products: z.number().int().min(0),
});

export const knowledgeApi = {
  loadSample: async (companyId: string) =>
    sampleLoadSchema.parse(
      await request(`${companyPath(companyId)}/knowledge/sample`, { method: 'POST' }),
    ),
  removeSample: async (companyId: string) =>
    sampleRemoveSchema.parse(
      await request(`${companyPath(companyId)}/knowledge/sample`, { method: 'DELETE' }),
    ),
  documents: async (companyId: string, cursor?: string) =>
    documentsPageSchema.parse(
      await request(
        `${companyPath(companyId)}/knowledge/documents?limit=${String(KNOWLEDGE_PAGE_SIZE)}${
          cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
        }`,
      ),
    ),
  create: async (companyId: string, body: { title: string; content: string }) =>
    documentSchema.parse(
      await request(`${companyPath(companyId)}/knowledge/documents`, { method: 'POST', body }),
    ),
  remove: async (companyId: string, documentId: string): Promise<void> => {
    await request(
      `${companyPath(companyId)}/knowledge/documents/${encodeURIComponent(documentId)}`,
      {
        method: 'DELETE',
      },
    );
  },
};

export const KNOWLEDGE_LIMIT_MESSAGE =
  'Limite da base de conhecimento atingido (50 documentos). Apague algum para adicionar outro.';
export const KNOWLEDGE_TOO_LARGE_MESSAGE =
  'O documento é grande demais. Divida o texto em documentos menores.';
export const KNOWLEDGE_INVALID_MESSAGE =
  'Confira o título e o texto do documento (os dois são obrigatórios).';
export const SAMPLE_REQUIRES_EMPTY_MESSAGE =
  'O exemplo só carrega em uma empresa vazia (sem documentos nem produtos).';
export const KNOWLEDGE_STALE_MESSAGE = 'Este documento não existe mais. A lista foi atualizada.';

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  KNOWLEDGE_LIMIT_REACHED: KNOWLEDGE_LIMIT_MESSAGE,
  KNOWLEDGE_DOCUMENT_TOO_LARGE: KNOWLEDGE_TOO_LARGE_MESSAGE,
  SAMPLE_REQUIRES_EMPTY: SAMPLE_REQUIRES_EMPTY_MESSAGE,
};

/**
 * Mensagem própria da base de conhecimento para uma falha, ou `null` quando ela é de outro tipo
 * (sessão, empresa trocada, permissão, indisponível), que a área da empresa trata em `settle`.
 */
export function knowledgeMessageOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const known = error.code === undefined ? undefined : CODE_MESSAGES[error.code];
  if (known !== undefined) return known;
  if (error.status === 400) return KNOWLEDGE_INVALID_MESSAGE;
  return null;
}
