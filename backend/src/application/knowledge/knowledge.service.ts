import {
  type CompanyId,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  KNOWLEDGE_MAX_CHUNKS,
  KNOWLEDGE_MAX_DOCUMENTS,
  KNOWLEDGE_PREVIEW_LENGTH,
  KNOWLEDGE_TITLE_MAX_LENGTH,
  type KnowledgeDocument,
  type KnowledgeDocumentRepository,
  type ListOptions,
  type NewKnowledgeChunk,
  type Page,
} from '../../domain/index.js';
import { ConflictError, ValidationError } from '../../shared/errors/index.js';
import { chunkText, KNOWLEDGE_DOCUMENT_TOO_LARGE, normalizeDocumentText } from './chunker.js';
import { buildSearchText } from './normalize.js';

export const KNOWLEDGE_LIMIT_REACHED = 'KNOWLEDGE_LIMIT_REACHED';

export interface NewDocumentInput {
  readonly title: string;
  readonly content: string;
}

/**
 * Documentos da base de conhecimento (spec 026). O `CompanyId` vem sempre da identidade
 * autenticada. Título e texto nunca vão a log nem a métrica.
 */
export class KnowledgeService {
  constructor(private readonly documents: KnowledgeDocumentRepository) {}

  list(companyId: CompanyId, options?: ListOptions): Promise<Page<KnowledgeDocument>> {
    return this.documents.list(companyId, options);
  }

  /**
   * Normaliza, divide em trechos e grava documento e trechos numa transação. Os tetos de contagem
   * são de melhor esforço sob concorrência; os de tamanho são exatos.
   */
  async create(
    companyId: CompanyId,
    membershipId: string,
    input: NewDocumentInput,
    options: { readonly isSample?: boolean } = {},
  ): Promise<KnowledgeDocument> {
    const title = input.title.normalize('NFC').trim();
    if (title.length === 0 || title.length > KNOWLEDGE_TITLE_MAX_LENGTH) {
      throw new ValidationError('Título inválido');
    }
    if (title.includes(String.fromCharCode(0))) {
      throw new ValidationError('O título não pode conter o caractere NUL');
    }
    const text = normalizeDocumentText(input.content);
    if (text.length > KNOWLEDGE_CONTENT_MAX_LENGTH) {
      throw new ValidationError('Documento grande demais', { code: KNOWLEDGE_DOCUMENT_TOO_LARGE });
    }
    const pieces = chunkText(text);
    const chunks: NewKnowledgeChunk[] = pieces.map((content) => ({
      content,
      // O título entra no texto indexado de todos os trechos (com e sem acentos).
      searchText: buildSearchText(`${title} ${content}`),
    }));

    const [documents, existingChunks] = await Promise.all([
      this.documents.countDocuments(companyId),
      this.documents.countChunks(companyId),
    ]);
    if (
      documents >= KNOWLEDGE_MAX_DOCUMENTS ||
      existingChunks + chunks.length > KNOWLEDGE_MAX_CHUNKS
    ) {
      throw new ConflictError('Limite da base de conhecimento atingido', {
        code: KNOWLEDGE_LIMIT_REACHED,
      });
    }

    return this.documents.createWithChunks(
      companyId,
      {
        title,
        charCount: text.length,
        preview: text.replace(/\s+/g, ' ').slice(0, KNOWLEDGE_PREVIEW_LENGTH),
        isSample: options.isSample ?? false,
        createdByMembershipId: membershipId,
      },
      chunks,
    );
  }

  /** `NotFoundError` se o documento não existe nesta empresa (igual a id de outra empresa). */
  delete(companyId: CompanyId, documentId: string): Promise<void> {
    return this.documents.delete(companyId, documentId);
  }
}
