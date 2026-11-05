import type { ListOptions, Page } from './pagination.js';
import type { CompanyId } from './value-objects/company-id.js';

/**
 * Base de conhecimento da empresa (spec 026): documentos de texto que o atendimento recupera por
 * busca textual. Todos os limites são constantes nomeadas (sem variável de ambiente).
 */
export const KNOWLEDGE_TITLE_MAX_LENGTH = 120;
/** Texto do documento (caracteres), depois de normalizado. */
export const KNOWLEDGE_CONTENT_MAX_LENGTH = 100_000;
/** Tamanho alvo de cada trecho (chunk) em caracteres. */
export const KNOWLEDGE_CHUNK_MAX_CHARS = 800;
export const KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT = 150;
export const KNOWLEDGE_MAX_DOCUMENTS = 50;
export const KNOWLEDGE_MAX_CHUNKS = 2_000;
export const KNOWLEDGE_PREVIEW_LENGTH = 160;

/** Tetos por turno do atendimento. */
export const KNOWLEDGE_MAX_PASSAGES = 4;
export const KNOWLEDGE_MAX_PRODUCTS = 5;
export const KNOWLEDGE_BLOCK_MAX_CHARS = 4_000;
export const KNOWLEDGE_PRODUCT_DESCRIPTION_PROMPT_CHARS = 200;
/** Prazo da recuperação (fail-open: estourou, atende sem contexto). */
export const KNOWLEDGE_RETRIEVAL_TIMEOUT_MS = 1_500;
/** Consulta: caracteres do texto do contato considerados e termos máximos na `tsquery`. */
export const KNOWLEDGE_QUERY_MAX_CHARS = 500;
export const KNOWLEDGE_QUERY_MAX_TERMS = 12;
/** Relevância mínima (`ts_rank_cd`) e fração mínima da melhor nota para um acerto entrar. */
export const KNOWLEDGE_MIN_RANK = 0.05;
export const KNOWLEDGE_RELATIVE_RANK_FLOOR = 0.5;

export interface KnowledgeDocument {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly title: string;
  readonly charCount: number;
  readonly chunkCount: number;
  /** Primeiros caracteres do texto; nunca o documento inteiro. */
  readonly preview: string;
  readonly isSample: boolean;
  readonly createdAt: Date;
}

export interface NewKnowledgeDocument {
  readonly title: string;
  readonly charCount: number;
  readonly preview: string;
  readonly isSample: boolean;
  readonly createdByMembershipId: string;
}

/** Trecho pronto para gravar: `content` é o original (vai ao modelo) e `searchText` só serve à busca. */
export interface NewKnowledgeChunk {
  readonly content: string;
  readonly searchText: string;
}

/**
 * Documentos e trechos de uma empresa. `CompanyId` é o primeiro parâmetro de todo método. Sem
 * `update`: documento é imutável (só adicionar e apagar).
 */
export interface KnowledgeDocumentRepository {
  /** Mais recentes primeiro, paginado por cursor. */
  list(companyId: CompanyId, options?: ListOptions): Promise<Page<KnowledgeDocument>>;
  /** Grava o documento e todos os trechos na mesma transação. */
  createWithChunks(
    companyId: CompanyId,
    document: NewKnowledgeDocument,
    chunks: readonly NewKnowledgeChunk[],
  ): Promise<KnowledgeDocument>;
  /** Apaga o documento (os trechos vão por cascata); `NotFoundError` se não existe nesta empresa. */
  delete(companyId: CompanyId, documentId: string): Promise<void>;
  countDocuments(companyId: CompanyId): Promise<number>;
  countChunks(companyId: CompanyId): Promise<number>;
  /** Quantos documentos de exemplo a empresa tem (spec 026, E3). */
  countSamples(companyId: CompanyId): Promise<number>;
  /** Apaga os documentos de exemplo (e os trechos, por cascata). Devolve quantos. */
  deleteSamples(companyId: CompanyId): Promise<number>;
}
