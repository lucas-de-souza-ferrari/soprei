-- Spec 027 (etapa E1): agenda da empresa. Migration ADITIVA: quatro enums, cinco tabelas novas, a extensao
-- btree_gist (trusted, criada aqui e nunca a mao) e a restricao de exclusao que impede dupla reserva. Nenhuma
-- alteracao em tabela existente.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "appointment_kind" AS ENUM ('BOOKING', 'BLOCK');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('PANEL', 'CHANNEL');

-- CreateEnum
CREATE TYPE "appointment_cancelled_by" AS ENUM ('PANEL', 'CONTACT');

-- CreateTable
CREATE TABLE "schedule_settings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "slot_step_minutes" INTEGER NOT NULL DEFAULT 30,
    "min_notice_minutes" INTEGER NOT NULL DEFAULT 120,
    "max_advance_days" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_resources" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_services" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "service_id" UUID,
    "kind" "appointment_kind" NOT NULL,
    "status" "appointment_status" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "blocked_until" TIMESTAMPTZ(6) NOT NULL,
    "customer_label" TEXT,
    "contact_ref" TEXT,
    "source" "appointment_source" NOT NULL,
    "created_by_membership_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" "appointment_cancelled_by",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_settings_company_id_key" ON "schedule_settings"("company_id");

-- CreateIndex
CREATE INDEX "schedule_resources_company_id_position_id_idx" ON "schedule_resources"("company_id", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_resources_id_company_id_key" ON "schedule_resources"("id", "company_id");

-- CreateIndex
CREATE INDEX "schedule_services_company_id_name_id_idx" ON "schedule_services"("company_id", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_services_id_company_id_key" ON "schedule_services"("id", "company_id");

-- CreateIndex
CREATE INDEX "availability_rules_company_id_resource_id_weekday_idx" ON "availability_rules"("company_id", "resource_id", "weekday");

-- CreateIndex
CREATE INDEX "appointments_company_id_starts_at_id_idx" ON "appointments"("company_id", "starts_at", "id");

-- CreateIndex
CREATE INDEX "appointments_company_id_resource_id_starts_at_idx" ON "appointments"("company_id", "resource_id", "starts_at");

-- AddForeignKey
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_services" ADD CONSTRAINT "schedule_services_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_resource_id_company_id_fkey" FOREIGN KEY ("resource_id", "company_id") REFERENCES "schedule_resources"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_resource_id_company_id_fkey" FOREIGN KEY ("resource_id", "company_id") REFERENCES "schedule_resources"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_company_id_fkey" FOREIGN KEY ("service_id", "company_id") REFERENCES "schedule_services"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_membership_id_company_id_fkey" FOREIGN KEY ("created_by_membership_id", "company_id") REFERENCES "memberships"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECKs (defesa em profundidade: acompanham os limites da API).
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_timezone_check" CHECK (char_length("timezone") BETWEEN 1 AND 64);
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_step_check" CHECK ("slot_step_minutes" IN (5, 10, 15, 20, 30, 60));
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_notice_check" CHECK ("min_notice_minutes" BETWEEN 0 AND 10080);
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_advance_check" CHECK ("max_advance_days" BETWEEN 1 AND 365);
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_name_check" CHECK (char_length("name") BETWEEN 1 AND 80);
ALTER TABLE "schedule_services" ADD CONSTRAINT "schedule_services_name_check" CHECK (char_length("name") BETWEEN 1 AND 80);
ALTER TABLE "schedule_services" ADD CONSTRAINT "schedule_services_duration_check" CHECK ("duration_minutes" BETWEEN 5 AND 480 AND "duration_minutes" % 5 = 0);
ALTER TABLE "schedule_services" ADD CONSTRAINT "schedule_services_buffer_check" CHECK ("buffer_minutes" BETWEEN 0 AND 120);
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_window_check" CHECK ("start_minute" >= 0 AND "start_minute" < "end_minute" AND "end_minute" <= 1440);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_check" CHECK ("ends_at" > "starts_at" AND "blocked_until" >= "ends_at");
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_kind_check" CHECK (
  ("kind" = 'BLOCK' AND "service_id" IS NULL AND "contact_ref" IS NULL)
  OR ("kind" = 'BOOKING' AND "service_id" IS NOT NULL)
);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_check" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_check" CHECK ("cancelled_by" IS NULL OR "status" = 'CANCELLED');
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_source_check" CHECK (("source" = 'CHANNEL') = ("created_by_membership_id" IS NULL));
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_label_check" CHECK ("customer_label" IS NULL OR char_length("customer_label") BETWEEN 1 AND 60);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_ref_check" CHECK ("contact_ref" IS NULL OR char_length("contact_ref") BETWEEN 1 AND 128);

-- Anti-dupla-reserva: dois itens ATIVOS (PENDING ou CONFIRMED) do mesmo recurso nao podem ter intervalos
-- sobrepostos ([starts_at, blocked_until), semiaberto: o fim de um pode ser o inicio do outro). So na migration:
-- o Prisma nao representa EXCLUDE. Violacao = SQLSTATE 23P01, traduzida num ponto so, em infrastructure/database/.
-- CANCELLED, COMPLETED e NO_SHOW liberam o intervalo. A restricao vale para o painel, o canal e qualquer SQL manual.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap" EXCLUDE USING gist (
  "resource_id" WITH =,
  tstzrange("starts_at", "blocked_until", '[)') WITH &&
) WHERE ("status" IN ('PENDING', 'CONFIRMED'));
