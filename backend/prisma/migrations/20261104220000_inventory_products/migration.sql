-- Spec 026 (etapa E2): controle de estoque. Migration ADITIVA: um enum e duas tabelas novas; nenhuma
-- alteração em tabela existente. Sem extensão do PostgreSQL. O produto não é apagado (o livro de
-- movimentações o referencia com RESTRICT); a quantidade só muda por `delta` (atômico, na aplicação) e
-- o CHECK de faixa é a última barreira.

-- CreateEnum
CREATE TYPE "stock_reason" AS ENUM ('INITIAL', 'ENTRY', 'EXIT', 'LOSS', 'COUNT_CORRECTION', 'IMPORT');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price_cents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "low_stock_threshold" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "search_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "quantity_after" INTEGER NOT NULL,
    "reason" "stock_reason" NOT NULL,
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_sku_key" ON "products"("company_id", "sku");
CREATE UNIQUE INDEX "products_id_company_id_key" ON "products"("id", "company_id");
CREATE INDEX "products_company_id_name_id_idx" ON "products"("company_id", "name", "id");
CREATE INDEX "stock_movements_company_id_product_id_created_at_id_idx" ON "stock_movements"("company_id", "product_id", "created_at", "id");

-- Índice de busca textual (só na migration: o Prisma não representa índice sobre expressão). É o mesmo
-- formato do índice dos trechos de documentos; a consulta usa exatamente esta expressão.
CREATE INDEX "products_search_idx" ON "products" USING GIN (to_tsvector('portuguese'::regconfig, "search_text"));

-- AddForeignKey (COMPOSTAS com company_id: ligar dado de empresas diferentes é impossível)
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_company_id_fkey" FOREIGN KEY ("product_id", "company_id") REFERENCES "products"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_membership_id_company_id_fkey" FOREIGN KEY ("created_by_membership_id", "company_id") REFERENCES "memberships"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECKs (defesa em profundidade: acompanham os limites da API).
ALTER TABLE "products" ADD CONSTRAINT "products_sku_check" CHECK ("sku" ~ '^[A-Z0-9._-]{1,40}$');
ALTER TABLE "products" ADD CONSTRAINT "products_name_check" CHECK (char_length("name") BETWEEN 1 AND 120);
ALTER TABLE "products" ADD CONSTRAINT "products_description_check" CHECK (char_length("description") <= 500);
ALTER TABLE "products" ADD CONSTRAINT "products_price_check" CHECK ("price_cents" BETWEEN 0 AND 100000000);
ALTER TABLE "products" ADD CONSTRAINT "products_quantity_check" CHECK ("quantity" BETWEEN 0 AND 1000000);
ALTER TABLE "products" ADD CONSTRAINT "products_threshold_check" CHECK ("low_stock_threshold" BETWEEN 0 AND 1000000);
ALTER TABLE "products" ADD CONSTRAINT "products_search_text_check" CHECK (char_length("search_text") BETWEEN 1 AND 3000);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_delta_check" CHECK ("delta" <> 0 AND "delta" BETWEEN -1000000 AND 1000000);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_after_check" CHECK ("quantity_after" BETWEEN 0 AND 1000000);
