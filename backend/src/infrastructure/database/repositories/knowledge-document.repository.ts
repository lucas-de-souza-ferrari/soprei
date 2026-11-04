import type {
  CompanyId,
  KnowledgeDocument,
  KnowledgeDocumentRepository,
  ListOptions,
  NewKnowledgeChunk,
  NewKnowledgeDocument,
  Page,
} from '../../../domain/index.js';
import { CompanyId as CompanyIdFactory } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { buildDescPageQuery, descOrderBy, toPage } from './cursor.js';
import { withRepositoryErrors } from './repository-errors.js';

interface DocumentRow {
  readonly id: string;
  readonly companyId: string;
  readonly title: string;
  readonly charCount: number;
  readonly chunkCount: number;
  readonly preview: string;
  readonly isSample: boolean;
  readonly createdAt: Date;
}

function toDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    companyId: CompanyIdFactory.parse(row.companyId),
    title: row.title,
    charCount: row.charCount,
    chunkCount: row.chunkCount,
    preview: row.preview,
    isSample: row.isSample,
    createdAt: row.createdAt,
  };
}

/**
 * Documentos da base de conhecimento (spec 026, model de tenant). `companyId` em todo `where` e
 * em todo `create`; a `tenant-scope` recusa o que escapar. As chaves estrangeiras compostas do
 * banco impedem ligar trecho a documento de outra empresa. Sem `update`: o documento é imutável.
 */
export class PrismaKnowledgeDocumentRepository implements KnowledgeDocumentRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  private get db(): TenantScopedDb {
    return this.prisma;
  }

  list(companyId: CompanyId, options?: ListOptions): Promise<Page<KnowledgeDocument>> {
    return withRepositoryErrors('KnowledgeDocument.list', async () => {
      const { limit, take, after } = buildDescPageQuery(options);
      const rows = await this.db.knowledgeDocument.findMany({
        where: { companyId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: descOrderBy(),
        take,
      });
      return toPage(rows, limit, toDocument);
    });
  }

  createWithChunks(
    companyId: CompanyId,
    document: NewKnowledgeDocument,
    chunks: readonly NewKnowledgeChunk[],
  ): Promise<KnowledgeDocument> {
    return withRepositoryErrors('KnowledgeDocument.create', () =>
      runInTransaction(this.prisma, async (tx) => {
        const row = await tx.knowledgeDocument.create({
          data: {
            companyId,
            title: document.title,
            charCount: document.charCount,
            chunkCount: chunks.length,
            preview: document.preview,
            isSample: document.isSample,
            createdByMembershipId: document.createdByMembershipId,
          },
        });
        await tx.knowledgeChunk.createMany({
          data: chunks.map((chunk, position) => ({
            companyId,
            documentId: row.id,
            position,
            content: chunk.content,
            searchText: chunk.searchText,
          })),
        });
        return toDocument(row);
      }),
    );
  }

  delete(companyId: CompanyId, documentId: string): Promise<void> {
    return withRepositoryErrors('KnowledgeDocument.delete', async () => {
      const notFound = (): NotFoundError =>
        new NotFoundError('Recurso não encontrado', { context: { entity: 'KnowledgeDocument' } });
      if (!isUuid(documentId)) throw notFound();
      // Os trechos saem por cascata (FK composta `ON DELETE CASCADE`).
      const { count } = await this.db.knowledgeDocument.deleteMany({
        where: { id: documentId, companyId },
      });
      if (count === 0) throw notFound();
    });
  }

  countDocuments(companyId: CompanyId): Promise<number> {
    return withRepositoryErrors('KnowledgeDocument.count', () =>
      this.db.knowledgeDocument.count({ where: { companyId } }),
    );
  }

  countChunks(companyId: CompanyId): Promise<number> {
    return withRepositoryErrors('KnowledgeChunk.count', () =>
      this.db.knowledgeChunk.count({ where: { companyId } }),
    );
  }
}
