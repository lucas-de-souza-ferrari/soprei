-- Spec 045, E3a: ações do admin da plataforma sobre empresas e vínculos (renomear, remover e restaurar a
-- empresa; mudar o papel, desativar e reativar um vínculo). Aditiva e compatível com a versão anterior do
-- código: só valores novos no enum da trilha da plataforma, três colunas anuláveis (que a versão anterior
-- nunca grava nem lê), a chave estrangeira do vínculo e um índice. Nada é apagado, renomeado nem reescrito.
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'COMPANY_RENAMED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'COMPANY_REMOVED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'COMPANY_RESTORED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_DISABLED_BY_PLATFORM';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_ENABLED_BY_PLATFORM';

ALTER TABLE "platform_audit_events" ADD COLUMN "subject_membership_id" UUID;
ALTER TABLE "platform_audit_events" ADD COLUMN "from_role" "membership_role";
ALTER TABLE "platform_audit_events" ADD COLUMN "to_role" "membership_role";

-- O vínculo nunca é apagado (a trilha da empresa já aponta para ele): RESTRICT, como a da empresa.
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_subject_membership_id_fkey" FOREIGN KEY ("subject_membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "platform_audit_events_subject_membership_id_idx" ON "platform_audit_events"("subject_membership_id");
