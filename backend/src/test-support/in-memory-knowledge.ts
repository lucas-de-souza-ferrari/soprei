import { randomUUID } from 'node:crypto';
import {
  type CompanyId,
  DEFAULT_LIST_LIMIT,
  type KnowledgeDocument,
  type KnowledgeDocumentRepository,
  type ListOptions,
  type NewKnowledgeChunk,
  type NewKnowledgeDocument,
  type Page,
} from '../domain/index.js';
import { NotFoundError } from '../shared/errors/index.js';
import { isUuid } from '../shared/utils/index.js';

/**
 * Documentos da base de conhecimento em memória (spec 026), para testes de service e de rota que
 * não precisam de banco. Tudo filtrado pelo `CompanyId`; id de outra empresa é `NotFoundError`.
 */
export class InMemoryKnowledgeDocumentRepository implements KnowledgeDocumentRepository {
  readonly rows: { document: KnowledgeDocument; chunks: readonly NewKnowledgeChunk[] }[] = [];
  private tick = 0;

  list(companyId: CompanyId, options: ListOptions = {}): Promise<Page<KnowledgeDocument>> {
    const own = this.rows
      .filter((row) => row.document.companyId === companyId)
      .map((row) => row.document)
      .reverse();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const items = own.slice(start, start + limit);
    const next = start + limit < own.length ? String(start + limit) : null;
    return Promise.resolve({ items, nextCursor: next });
  }

  createWithChunks(
    companyId: CompanyId,
    document: NewKnowledgeDocument,
    chunks: readonly NewKnowledgeChunk[],
  ): Promise<KnowledgeDocument> {
    const created: KnowledgeDocument = {
      id: randomUUID(),
      companyId,
      title: document.title,
      charCount: document.charCount,
      chunkCount: chunks.length,
      preview: document.preview,
      isSample: document.isSample,
      createdAt: new Date(Date.UTC(2026, 10, 4) + (this.tick += 1)),
    };
    this.rows.push({ document: created, chunks });
    return Promise.resolve(created);
  }

  delete(companyId: CompanyId, documentId: string): Promise<void> {
    const index = isUuid(documentId)
      ? this.rows.findIndex(
          (row) => row.document.id === documentId && row.document.companyId === companyId,
        )
      : -1;
    if (index === -1) return Promise.reject(new NotFoundError('Recurso não encontrado'));
    this.rows.splice(index, 1);
    return Promise.resolve();
  }

  countDocuments(companyId: CompanyId): Promise<number> {
    return Promise.resolve(this.rows.filter((row) => row.document.companyId === companyId).length);
  }

  countChunks(companyId: CompanyId): Promise<number> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.document.companyId === companyId)
        .reduce((sum, row) => sum + row.chunks.length, 0),
    );
  }
}
