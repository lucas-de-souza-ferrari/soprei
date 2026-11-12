-- Spec 031 (E3, revisao): a referencia da transacao e a fatura da InfinitePay so podem pertencer a UM pedido.
-- Migration ADITIVA: dois indices unicos PARCIAIS (so onde nao e nulo; o Prisma nao os representa). Se a mesma
-- referencia aparecer em dois pedidos, a concessao do segundo desfaz a transacao e vai para revisao manual.

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_transaction_ref_key" ON "payment_orders"("provider_transaction_ref") WHERE "provider_transaction_ref" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_slug_key" ON "payment_orders"("provider_slug") WHERE "provider_slug" IS NOT NULL;
