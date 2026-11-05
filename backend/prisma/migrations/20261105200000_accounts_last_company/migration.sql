-- Spec 029 (E2): ultima empresa selecionada pela conta. Migration ADITIVA: uma coluna anulavel, sua FK
-- (ON DELETE SET NULL: empresa removida zera a dica) e um indice para a FK. A coluna e so uma dica de
-- conveniencia para abrir a empresa certa depois do login; o vinculo continua sendo revalidado a cada uso.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "last_company_id" UUID;

-- CreateIndex
CREATE INDEX "accounts_last_company_id_idx" ON "accounts"("last_company_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_last_company_id_fkey" FOREIGN KEY ("last_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
