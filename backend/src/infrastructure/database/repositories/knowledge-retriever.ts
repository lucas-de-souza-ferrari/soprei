import {
  type CompanyId,
  KNOWLEDGE_MAX_PASSAGES,
  KNOWLEDGE_MAX_PRODUCTS,
  KNOWLEDGE_MIN_RANK,
  KNOWLEDGE_RELATIVE_RANK_FLOOR,
} from '../../../domain/index.js';
import type {
  KnowledgeRetrieval,
  KnowledgeRetriever,
  RetrievedPassage,
  RetrievedProduct,
} from '../../../application/ports/knowledge-retriever.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

interface PassageRow {
  readonly document_id: string;
  readonly title: string;
  readonly content: string;
  readonly rank: number;
}

interface ProductRow {
  readonly product_id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly price_cents: number;
  readonly quantity: number;
  readonly updated_at: Date;
  readonly rank: number;
}

/** Mantém só os acertos relevantes: nota mínima e pelo menos metade da melhor nota. */
function relevant<T extends { readonly rank: number }>(rows: readonly T[]): T[] {
  const best = rows[0]?.rank ?? 0;
  return rows.filter(
    (row) => row.rank >= KNOWLEDGE_MIN_RANK && row.rank >= best * KNOWLEDGE_RELATIVE_RANK_FLOOR,
  );
}

/**
 * Recuperação da base de conhecimento e do estoque (spec 026): o ÚNICO SQL cru novo da spec. Consultas
 * parametrizadas, com `company_id = $n` em toda cláusula `WHERE` (inclusive nos `EXISTS`). A `tsquery`
 * é montada em TypeScript só com letras e dígitos e vai como parâmetro a `to_tsquery('portuguese', $n)`.
 * A expressão `to_tsvector('portuguese'::regconfig, search_text)` é a dos índices GIN das migrations.
 * Só produtos **ativos** são recuperados.
 */
export class PrismaKnowledgeRetriever implements KnowledgeRetriever {
  constructor(private readonly db: TenantScopedDb) {}

  retrieve(companyId: CompanyId, tsquery: string): Promise<KnowledgeRetrieval> {
    return withRepositoryErrors('Knowledge.retrieve', async () => {
      const [passages, products, exists] = await Promise.all([
        this.searchPassages(companyId, tsquery),
        this.searchProducts(companyId, tsquery),
        this.hasAny(companyId),
      ]);
      return { passages, products, hasAnyKnowledge: exists };
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
    return relevant(rows).map((row) => ({
      documentId: row.document_id,
      title: row.title,
      content: row.content,
    }));
  }

  private async searchProducts(companyId: CompanyId, tsquery: string): Promise<RetrievedProduct[]> {
    const rows = await this.db.$queryRaw<ProductRow[]>`
      SELECT p.id::text AS product_id, p.sku AS sku, p.name AS name, p.description AS description,
             p.price_cents AS price_cents, p.quantity AS quantity, p.updated_at AS updated_at,
             ts_rank_cd(to_tsvector('portuguese'::regconfig, p.search_text),
                        to_tsquery('portuguese'::regconfig, ${tsquery}))::float8 AS rank
        FROM products p
       WHERE p.company_id = ${companyId}::uuid
         AND p.active = true
         AND to_tsvector('portuguese'::regconfig, p.search_text)
             @@ to_tsquery('portuguese'::regconfig, ${tsquery})
       ORDER BY rank DESC, p.id
       LIMIT ${KNOWLEDGE_MAX_PRODUCTS}`;
    return relevant(rows).map((row) => ({
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      priceCents: row.price_cents,
      quantity: row.quantity,
      updatedAt: row.updated_at,
    }));
  }

  private async hasAny(companyId: CompanyId): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ present: boolean }[]>`
      SELECT (EXISTS (SELECT 1 FROM knowledge_chunks WHERE company_id = ${companyId}::uuid)
           OR EXISTS (SELECT 1 FROM products WHERE company_id = ${companyId}::uuid AND active = true)
             ) AS present`;
    return rows[0]?.present === true;
  }
}
