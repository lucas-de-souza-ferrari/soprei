-- Spec 031 (E3): checkout da InfinitePay. Migration ADITIVA: tres colunas anulaveis em payment_orders
-- (identificador da fatura, forma de pagamento e marca da ultima consulta da reconciliacao). Nenhum dado muda.

-- AlterTable
ALTER TABLE "payment_orders" ADD COLUMN     "provider_slug" TEXT,
ADD COLUMN     "capture_method" TEXT,
ADD COLUMN     "last_checked_at" TIMESTAMPTZ(6);
