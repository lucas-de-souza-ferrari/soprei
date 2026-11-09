-- Spec 031 (E1): planos e assinaturas. Migration ADITIVA: seis tabelas globais novas (catalogo versionado,
-- assinatura por conta, pedidos, uso por janela e avisos), a coluna anulavel companies.subscription_id e as
-- sementes do catalogo (SO o modo "a empresa paga a Meta", CUSTOMER_PAYS_META; o modo S nao e semeado e so
-- existe por linha nova depois de o dono confirmar a linha de credito). Nenhuma empresa ou conta existente muda.
-- Dinheiro sempre em centavos inteiros (BRL); a estimativa da Meta em milesimos de centavo.

-- CreateEnum
CREATE TYPE "plan_code" AS ENUM ('ESSENTIAL', 'PROFESSIONAL', 'SCALE');

-- CreateEnum
CREATE TYPE "billing_cycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "whatsapp_billing_mode" AS ENUM ('CUSTOMER_PAYS_META', 'SOPREI_PAYS_META');

-- CreateEnum
CREATE TYPE "payment_order_kind" AS ENUM ('NEW', 'RENEWAL', 'UPGRADE', 'EXTRA_PACK');

-- CreateEnum
CREATE TYPE "payment_order_status" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment_notice_kind" AS ENUM ('QUOTA_REPLIES_80', 'QUOTA_REPLIES_100', 'QUOTA_TOKENS_80', 'QUOTA_TOKENS_100', 'PERIOD_ENDING_7D', 'PERIOD_ENDING_1D', 'PERIOD_ENDED', 'PRICE_CHANGE');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "subscription_id" UUID;

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" "plan_code" NOT NULL,
    "name" TEXT NOT NULL,
    "max_companies" INTEGER NOT NULL,
    "monthly_tokens" BIGINT NOT NULL,
    "monthly_replies" INTEGER NOT NULL,
    "meta_estimate_milli_cents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "cycle" "billing_cycle" NOT NULL,
    "base_cents" INTEGER NOT NULL,
    "agenda_cents" INTEGER NOT NULL,
    "stock_cents" INTEGER NOT NULL,
    "whatsapp_billing_mode" "whatsapp_billing_mode" NOT NULL DEFAULT 'CUSTOMER_PAYS_META',
    "meta_per_reply_milli_cents" INTEGER NOT NULL,
    "extra_pack_cents" INTEGER NOT NULL,
    "extra_pack_replies" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "price_id" UUID NOT NULL,
    "cycle" "billing_cycle" NOT NULL,
    "agenda_enabled" BOOLEAN NOT NULL DEFAULT false,
    "stock_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "subscription_status" NOT NULL,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "trial_ends_at" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "pending_change" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "kind" "payment_order_kind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "status" "payment_order_status" NOT NULL DEFAULT 'PENDING',
    "checkout_url" TEXT,
    "provider_transaction_ref" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "tokens" BIGINT NOT NULL DEFAULT 0,
    "sent_messages" BIGINT NOT NULL DEFAULT 0,
    "extra_replies" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_notices" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "kind" "payment_notice_kind" NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_version_key" ON "plans"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_id_cycle_whatsapp_billing_mode_version_key" ON "plan_prices"("plan_id", "cycle", "whatsapp_billing_mode", "version");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_account_id_key" ON "subscriptions"("account_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "subscriptions_price_id_idx" ON "subscriptions"("price_id");

-- CreateIndex
CREATE INDEX "payment_orders_subscription_id_created_at_idx" ON "payment_orders"("subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_status_created_at_idx" ON "payment_orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_subscription_id_window_start_key" ON "usage_counters"("subscription_id", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "payment_notices_subscription_id_kind_window_start_key" ON "payment_notices"("subscription_id", "kind", "window_start");

-- CreateIndex
CREATE INDEX "companies_subscription_id_idx" ON "companies"("subscription_id");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "plan_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defesas no banco (o Prisma nao representa CHECK).
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_limits_check" CHECK ("max_companies" > 0 AND "monthly_tokens" > 0 AND "monthly_replies" > 0 AND "meta_estimate_milli_cents" >= 0);
ALTER TABLE "plan_prices"
  ADD CONSTRAINT "plan_prices_amounts_check" CHECK ("base_cents" > 0 AND "agenda_cents" >= 0 AND "stock_cents" >= 0 AND "meta_per_reply_milli_cents" >= 0 AND "extra_pack_cents" >= 0 AND "extra_pack_replies" >= 0);
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_period_check" CHECK ("current_period_end" > "current_period_start"),
  ADD CONSTRAINT "subscriptions_trial_check" CHECK ("status" <> 'TRIAL' OR "trial_ends_at" IS NOT NULL);
ALTER TABLE "payment_orders"
  ADD CONSTRAINT "payment_orders_amount_check" CHECK ("amount_cents" > 0);
ALTER TABLE "usage_counters"
  ADD CONSTRAINT "usage_counters_nonnegative_check" CHECK ("tokens" >= 0 AND "sent_messages" >= 0 AND "extra_replies" >= 0);

-- Sementes do catalogo (versao 1, modo CUSTOMER_PAYS_META).
INSERT INTO "plans" ("id", "code", "name", "max_companies", "monthly_tokens", "monthly_replies", "meta_estimate_milli_cents", "version", "active") VALUES
  (gen_random_uuid(), 'ESSENTIAL', 'Essencial', 1, 3000000, 800, 3500, 1, true),
  (gen_random_uuid(), 'PROFESSIONAL', 'Profissional', 3, 12000000, 3200, 3500, 1, true),
  (gen_random_uuid(), 'SCALE', 'Escala', 10, 40000000, 10800, 3500, 1, true);

INSERT INTO "plan_prices" ("id", "plan_id", "cycle", "base_cents", "agenda_cents", "stock_cents", "whatsapp_billing_mode", "meta_per_reply_milli_cents", "extra_pack_cents", "extra_pack_replies", "version", "valid_from")
SELECT gen_random_uuid(), p."id", v."cycle"::"billing_cycle", v."base", v."agenda", v."stock", 'CUSTOMER_PAYS_META', 3500, 5900, 500, 1, TIMESTAMPTZ '2026-11-01 00:00:00+00'
FROM "plans" p
JOIN (VALUES
  ('ESSENTIAL', 'MONTHLY', 5900, 2900, 1900),
  ('ESSENTIAL', 'ANNUAL', 56640, 27840, 18240),
  ('PROFESSIONAL', 'MONTHLY', 14900, 4900, 3900),
  ('PROFESSIONAL', 'ANNUAL', 143040, 47040, 37440),
  ('SCALE', 'MONTHLY', 34900, 9900, 7900),
  ('SCALE', 'ANNUAL', 335040, 95040, 75840)
) AS v("code", "cycle", "base", "agenda", "stock") ON v."code"::"plan_code" = p."code" AND p."version" = 1;
