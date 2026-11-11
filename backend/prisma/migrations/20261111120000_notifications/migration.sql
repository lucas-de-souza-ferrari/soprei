-- Spec 030: notificações do painel; a primeira é "atendimento humano solicitado".
-- Migration ADITIVA: três enums e uma tabela novos, nada é apagado nem reescrito. A notificação nunca
-- guarda texto de mensagem. Todas as chaves estrangeiras são COMPOSTAS com company_id (ligar dado de
-- empresas diferentes é impossível no próprio banco).

-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('HUMAN_HANDOFF');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "handoff_reason" AS ENUM ('CONTACT_REQUESTED', 'CANNOT_HELP', 'COMPLAINT', 'SENSITIVE', 'OTHER');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "reason" "handoff_reason",
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_membership_id" UUID,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_company_id_status_created_at_id_idx" ON "notifications"("company_id", "status", "created_at", "id");

-- CreateIndex
CREATE INDEX "notifications_company_id_conversation_id_idx" ON "notifications"("company_id", "conversation_id");

-- CreateIndex (alvo de chaves estrangeiras compostas futuras)
CREATE UNIQUE INDEX "notifications_id_company_id_key" ON "notifications"("id", "company_id");

-- Uma notificação ABERTA por conversa e tipo: a corrida entre dois pedidos na mesma conversa é decidida
-- pelo banco (INSERT ... ON CONFLICT DO NOTHING). Índice parcial: o Prisma não o representa.
CREATE UNIQUE INDEX "notifications_open_conversation_kind_key" ON "notifications"("company_id", "conversation_id", "kind") WHERE "status" = 'OPEN';

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_company_id_fkey" FOREIGN KEY ("conversation_id", "company_id") REFERENCES "conversations"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_message_id_company_id_fkey" FOREIGN KEY ("message_id", "company_id") REFERENCES "messages"("id", "company_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolved_by_membership_id_company_id_fkey" FOREIGN KEY ("resolved_by_membership_id", "company_id") REFERENCES "memberships"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HUMAN_HANDOFF exige motivo; outro tipo (futuro) não tem motivo de atendimento humano.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_reason_check" CHECK (("kind" = 'HUMAN_HANDOFF') = ("reason" IS NOT NULL));

-- OPEN: sem resolução; RESOLVED: quando e quem, os dois preenchidos.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolution_check" CHECK (
    (("status" = 'OPEN') = ("resolved_at" IS NULL))
    AND (("status" = 'OPEN') = ("resolved_by_membership_id" IS NULL))
);
