-- Spec 044, E1: segundo fator (TOTP) do administrador da plataforma e trilha das ações da plataforma.
-- Aditiva: duas colunas anuláveis, dois tipos e uma tabela nova; nada é apagado nem alterado.
-- CreateEnum
CREATE TYPE "platform_audit_action" AS ENUM ('PLATFORM_LOGIN', 'PLATFORM_LOGOUT', 'COMPANY_SUSPENDED', 'COMPANY_REACTIVATED', 'ACCOUNT_EMAIL_VIEWED');

-- CreateEnum
CREATE TYPE "platform_action_reason" AS ENUM ('PAYMENT', 'ABUSE', 'OWNER_REQUEST', 'OTHER');

-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_secret_ciphertext" TEXT;

-- CreateTable
CREATE TABLE "platform_audit_events" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" "platform_audit_action" NOT NULL,
    "subject_company_id" UUID,
    "subject_account_id" UUID,
    "reason" "platform_action_reason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_events_created_at_id_idx" ON "platform_audit_events"("created_at", "id");

-- CreateIndex
CREATE INDEX "platform_audit_events_subject_company_id_idx" ON "platform_audit_events"("subject_company_id");

-- CreateIndex
CREATE INDEX "platform_audit_events_subject_account_id_idx" ON "platform_audit_events"("subject_account_id");

-- AddForeignKey
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_subject_company_id_fkey" FOREIGN KEY ("subject_company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_subject_account_id_fkey" FOREIGN KEY ("subject_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

