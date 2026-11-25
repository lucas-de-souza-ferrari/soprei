-- breaking-approved: relaxa NOT NULL e CHECK do convite (convidador da plataforma); a versão anterior continua gravando o convidador de vínculo
-- Spec 045, E3b: o admin da plataforma convida (qualquer papel, inclusive OWNER) e cria empresa com o convite
-- do dono. O convite ganha o convidador admin; "exatamente um dos dois convidadores" passa a ser CHECK e só
-- o convite do admin pode ter papel OWNER. Nada é apagado nem reescrito: todo convite existente tem o
-- convidador de vínculo e papel diferente de OWNER, então passa nos CHECKs novos. A versão anterior do código
-- continua gravando só convites de vínculo; ela não sabe aceitar um convite com convidador admin (o aceite
-- dá a falha uniforme INVITATION_INVALID nesse intervalo, caso de borda da spec). Os valores novos de enum
-- não são usados nesta migration (um valor recém-acrescentado não pode ser usado na mesma transação).

-- O DDL abaixo trava company_invitations e platform_audit_events com a versão anterior no ar: espera no
-- máximo 5 s por uma trava em vez de enfileirar convites e aceites atrás dele (falha = deploy para, nada muda).
SET lock_timeout = '5s';

-- AlterEnum (só acrescenta)
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'COMPANY_CREATED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_CREATED_BY_PLATFORM';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_RESENT_BY_PLATFORM';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_REVOKED_BY_PLATFORM';

-- Convidador da plataforma
ALTER TABLE "company_invitations" ALTER COLUMN "invited_by_membership_id" DROP NOT NULL;
ALTER TABLE "company_invitations" ADD COLUMN "invited_by_admin_id" UUID;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_invited_by_admin_id_fkey" FOREIGN KEY ("invited_by_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_inviter_check" CHECK (
    ("invited_by_membership_id" IS NULL) <> ("invited_by_admin_id" IS NULL)
);

-- Só a plataforma convida OWNER.
ALTER TABLE "company_invitations" DROP CONSTRAINT "company_invitations_role_check";
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_role_check" CHECK (
    "role" <> 'OWNER' OR "invited_by_admin_id" IS NOT NULL
);

-- Trilha da plataforma: o convite alvo.
ALTER TABLE "platform_audit_events" ADD COLUMN "subject_invitation_id" UUID;
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_subject_invitation_id_fkey" FOREIGN KEY ("subject_invitation_id") REFERENCES "company_invitations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "platform_audit_events_subject_invitation_id_idx" ON "platform_audit_events"("subject_invitation_id");
