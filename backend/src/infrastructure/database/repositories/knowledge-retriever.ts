import {
  type CompanyId,
  KNOWLEDGE_MAX_PASSAGES,
  KNOWLEDGE_MIN_RANK,
  KNOWLEDGE_RELATIVE_RANK_FLOOR,
} from '../../../domain/index.js';
import type {
  KnowledgeRetrieval,
  KnowledgeRetriever,
  RetrievedPassage,
} from '../../../application/ports/knowledge-retriever.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

interface PassageRow {
  readonly document_id: string;
  readonly title: string;
  readonly content: string;
  readonly rank: number;
}

/**
 * Recuperação da base de conhecimento (spec 026): o ÚNICO SQL cru novo da spec. Consultas
 * parametrizadas, com `company_id = $n` em toda cláusula `WHERE` (inclusive no `EXISTS`). A `tsquery`
 * é montada em TypeScript só com `[a-z0-9]` e vai como parâmetro a `to_tsquery('portuguese', $n)`.
 * A expressão `to_tsvector('portuguese'::regconfig, search_text)` é a do índice GIN da migration.
 */
export class PrismaKnowledgeRetriever implements KnowledgeRetriever {
  constructor(private readonly db: TenantScopedDb) {}

  retrieve(companyId: CompanyId, tsquery: string): Promise<KnowledgeRetrieval> {
    return withRepositoryErrors('Knowledge.retrieve', async () => {
      const [passages, exists] = await Promise.all([
        this.searchPassages(companyId, tsquery),
        this.hasAny(companyId),
      ]);
      return { passages, products: [], hasAnyKnowledge: exists };
    });
  }

  private async searchPassages(companyId: CompanyId, tsquery: string): Promise<RetrievedPassage[]> {
    const rows = await this.db.$queryRaw<PassageRow[]>`
      SELECT c.document_id::text AS document_id, d.title AS title, c.content AS content,
             ts_rank_cd(to_tsvector('portuguese'::regconfig, c.search_text),
                        to_tsquery('portuguese'::regconfig, ${tsquery}))::float8 AS rank
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id AND d.company_id = c.company_id
       WHERE c.company_id = ${companyId}::uuid
         AND d.company_id = ${companyId}::uuid
         AND to_tsvector('portuguese'::regconfig, c.search_text)
             @@ to_tsquery('portuguese'::regconfig, ${tsquery})
       ORDER BY rank DESC, c.id
       LIMIT ${KNOWLEDGE_MAX_PASSAGES}`;
    const best = rows[0]?.rank ?? 0;
    return rows
      .filter(
        (row) => row.rank >= KNOWLEDGE_MIN_RANK && row.rank >= best * KNOWLEDGE_RELATIVE_RANK_FLOOR,
      )
      .map((row) => ({ documentId: row.document_id, title: row.title, content: row.content }));
  }

  private async hasAny(companyId: CompanyId): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM knowledge_chunks WHERE company_id = ${companyId}::uuid) AS present`;
    return rows[0]?.present === true;
  }
}
