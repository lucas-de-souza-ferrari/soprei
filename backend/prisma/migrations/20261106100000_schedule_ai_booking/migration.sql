-- Spec 028 (E2): a IA solicita, cancela e remarca horarios do proprio contato. Migration ADITIVA: duas colunas
-- booleanas com padrao desligado (nenhuma empresa existente muda de comportamento) e dois indices parciais.
-- Nenhum valor de enum novo e nenhuma coluna de idempotencia.

-- AlterTable
ALTER TABLE "schedule_settings" ADD COLUMN "ai_booking_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ai_auto_confirm" BOOLEAN NOT NULL DEFAULT false;

-- Confirmar automaticamente so faz sentido com a IA ligada.
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_ai_confirm_check" CHECK (NOT "ai_auto_confirm" OR "ai_booking_enabled");

-- Agendamentos ativos de um contato (so na migration: o Prisma nao representa indice parcial).
CREATE INDEX "appointments_contact_active_idx" ON "appointments"("company_id", "contact_ref", "starts_at")
  WHERE "contact_ref" IS NOT NULL AND "status" IN ('PENDING', 'CONFIRMED');

-- Criacoes de um contato nas ultimas 24 h, inclusive canceladas (cota contra "criar e cancelar em ciclo").
CREATE INDEX "appointments_contact_created_idx" ON "appointments"("company_id", "contact_ref", "created_at")
  WHERE "contact_ref" IS NOT NULL;
