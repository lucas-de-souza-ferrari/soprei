import type { CompanyId } from '../../domain/index.js';

/** Trecho de documento recuperado para uma pergunta (spec 026). `content` é o texto original. */
export interface RetrievedPassage {
  readonly documentId: string;
  readonly title: string;
  readonly content: string;
}

/** Produto recuperado para uma pergunta (spec 026, estoque). `updatedAt` é "a hora do dado". */
export interface RetrievedProduct {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly quantity: number;
  readonly updatedAt: Date;
}

export interface KnowledgeRetrieval {
  /** Melhores primeiro, no máximo `KNOWLEDGE_MAX_PASSAGES`. */
  readonly passages: readonly RetrievedPassage[];
  /** Só produtos ativos, melhores primeiro, no máximo `KNOWLEDGE_MAX_PRODUCTS`. */
  readonly products: readonly RetrievedProduct[];
  /** A empresa tem algum documento ou produto ativo (decide a linha "vou confirmar"). */
  readonly hasAnyKnowledge: boolean;
}

/**
 * Recupera da base da empresa o que é relevante à consulta (spec 026). Implementação em
 * `infrastructure/database/`; **sempre** filtra por `companyId`. A consulta (`tsquery` já montada
 * por `buildQuery`) é parâmetro e nunca vai a log.
 */
export interface KnowledgeRetriever {
  retrieve(companyId: CompanyId, tsquery: string): Promise<KnowledgeRetrieval>;
}
