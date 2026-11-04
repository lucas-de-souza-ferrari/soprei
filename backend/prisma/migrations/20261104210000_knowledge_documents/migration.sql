-- Spec 026 (etapa E1): base de conhecimento da IA. Migration ADITIVA: duas tabelas novas; nenhuma
-- alteração em tabela existente. Sem extensão do PostgreSQL: a configuração de busca `portuguese`
-- (dicionário Snowball) é nativa. Os acentos são removidos em TypeScript antes de gravar.

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "char_count" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "preview" TEXT NOT NULL,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "search_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (alvo da chave estrangeira composta dos trechos)
CREATE UNIQUE INDEX "knowledge_documents_id_company_id_key" ON "knowledge_documents"("id", "company_id");
CREATE INDEX "knowledge_documents_company_id_created_at_id_idx" ON "knowledge_documents"("company_id", "created_at", "id");
CREATE INDEX "knowledge_chunks_company_id_document_id_position_idx" ON "knowledge_chunks"("company_id", "document_id", "position");

-- Índice de busca textual (só na migration: o Prisma não representa índice sobre expressão). A consulta
-- usa exatamente esta expressão (`to_tsvector('portuguese'::regconfig, search_text)`) para usá-lo.
CREATE INDEX "knowledge_chunks_search_idx" ON "knowledge_chunks" USING GIN (to_tsvector('portuguese'::regconfig, "search_text"));

-- AddForeignKey (COMPOSTAS com company_id: ligar dado de empresas diferentes é impossível)
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_created_by_membership_id_company_id_fkey" FOREIGN KEY ("created_by_membership_id", "company_id") REFERENCES "memberships"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_company_id_fkey" FOREIGN KEY ("document_id", "company_id") REFERENCES "knowledge_documents"("id", "company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECKs de tamanho (defesa em profundidade: acompanham os limites da API).
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_title_check" CHECK (char_length("title") BETWEEN 1 AND 120);
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_char_count_check" CHECK ("char_count" BETWEEN 1 AND 100000);
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_chunk_count_check" CHECK ("chunk_count" BETWEEN 1 AND 150);
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_preview_check" CHECK (char_length("preview") <= 160);
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_content_check" CHECK (char_length("content") BETWEEN 1 AND 100000);
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_search_text_check" CHECK (char_length("search_text") BETWEEN 1 AND 6000);
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_position_check" CHECK ("position" >= 0);
