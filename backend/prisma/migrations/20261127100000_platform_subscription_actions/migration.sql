-- Spec 045, E4: ações do admin da plataforma sobre a assinatura de uma conta (iniciar teste, conceder dias,
-- módulos, trocar plano, cancelar e reativar no fim do período, encerrar agora). Aditiva e compatível com a
-- versão anterior do código: só valores novos no enum da trilha da plataforma e quatro colunas anuláveis (que
-- a versão anterior nunca grava nem lê). Nada é apagado, renomeado nem reescrito.
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_TRIAL_STARTED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_EXTENDED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_MODULES_CHANGED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_PLAN_CHANGED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_CANCELLED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_REACTIVATED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_ENDED';

ALTER TABLE "platform_audit_events" ADD COLUMN "plan_code" "plan_code";
ALTER TABLE "platform_audit_events" ADD COLUMN "days" SMALLINT;
ALTER TABLE "platform_audit_events" ADD COLUMN "module_schedule" BOOLEAN;
ALTER TABLE "platform_audit_events" ADD COLUMN "module_inventory" BOOLEAN;
