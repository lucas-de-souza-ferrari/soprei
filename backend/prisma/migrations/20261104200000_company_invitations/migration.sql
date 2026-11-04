-- Spec 025: convites por e-mail e gestão da equipe.
-- Migration ADITIVA: tabela e enum novos, uma coluna anulável em audit_events, quatro valores novos em
-- audit_action e o CHECK por ação recriado (o conjunto antigo continua válido). Nada é apagado nem
-- reescrito. O e-mail do convidado (dado pessoal) e o HMAC do segredo só existem em convite PENDING:
-- o banco os anula ao fechar (CHECK). Os valores novos de enum não são usados nesta migration (um valor
-- recém-acrescentado não pode ser usado na mesma transação): o CHECK compara o TEXTO da ação.

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterEnum (só acrescenta)
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_CREATED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_RESENT';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_REVOKED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVITATION_ACCEPTED';

-- CreateTable
CREATE TABLE "company_invitations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email" TEXT,
    "role" "membership_role" NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "token_hash" TEXT,
    "invited_by_membership_id" UUID NOT NULL,
    "accepted_membership_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL,
    "send_count" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "company_invitations_pkey" PRIMARY KEY ("id")
);

-- AlterTable: o convite a que um evento INVITATION_* se refere (só o id; nunca o e-mail).
ALTER TABLE "audit_events" ADD COLUMN "invitation_id" UUID;

-- CreateIndex
CREATE INDEX "company_invitations_company_id_status_created_at_id_idx" ON "company_invitations"("company_id", "status", "created_at", "id");

-- CreateIndex (alvo das chaves estrangeiras compostas)
CREATE UNIQUE INDEX "company_invitations_id_company_id_key" ON "company_invitations"("id", "company_id");

-- Um convite PENDING por e-mail e empresa: a corrida entre dois convites ao mesmo e-mail é decidida
-- pelo banco. O índice é parcial (o Prisma não o representa); convite fechado tem e-mail NULL.
CREATE UNIQUE INDEX "company_invitations_pending_email_key" ON "company_invitations"("company_id", "email") WHERE "status" = 'PENDING';

-- AddForeignKey (todas COMPOSTAS com company_id: ligar dado de empresas diferentes é impossível)
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_invited_by_membership_id_company_id_fkey" FOREIGN KEY ("invited_by_membership_id", "company_id") REFERENCES "memberships"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_accepted_membership_id_company_id_fkey" FOREIGN KEY ("accepted_membership_id", "company_id") REFERENCES "memberships"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_invitation_id_company_id_fkey" FOREIGN KEY ("invitation_id", "company_id") REFERENCES "company_invitations"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- OWNER nunca é convidável (o papel de proprietário só se ganha por promoção, com hierarquia e auditoria).
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_role_check" CHECK ("role" <> 'OWNER');

-- PENDING exige e-mail e hash; qualquer outro estado exige os dois NULOS (o banco impede guardar o
-- e-mail de um convite fechado). ACCEPTED exige o vínculo criado; só PENDING tem closed_at nulo.
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_state_check" CHECK (
    (("status" = 'PENDING') = ("email" IS NOT NULL))
    AND (("status" = 'PENDING') = ("token_hash" IS NOT NULL))
    AND (("status" = 'ACCEPTED') = ("accepted_membership_id" IS NOT NULL))
    AND (("status" = 'PENDING') = ("closed_at" IS NULL))
);
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_send_count_check" CHECK ("send_count" BETWEEN 1 AND 6);
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_email_length_check" CHECK ("email" IS NULL OR char_length("email") <= 254);

-- CHECK por ação (recriado; compara o TEXTO da ação): MEMBERSHIP_* exige alvo e nenhum convite;
-- CHANNEL_* exige os dois nulos; INVITATION_CREATED/RESENT/REVOKED exigem o convite e nenhum alvo;
-- INVITATION_ACCEPTED exige o convite e o alvo (o novo vínculo).
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_target_by_action_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_by_action_check" CHECK (
    ("action"::text LIKE 'MEMBERSHIP\_%' AND "target_membership_id" IS NOT NULL AND "invitation_id" IS NULL)
    OR ("action"::text LIKE 'CHANNEL\_%' AND "target_membership_id" IS NULL AND "invitation_id" IS NULL)
    OR ("action"::text IN ('INVITATION_CREATED', 'INVITATION_RESENT', 'INVITATION_REVOKED') AND "invitation_id" IS NOT NULL AND "target_membership_id" IS NULL)
    OR ("action"::text = 'INVITATION_ACCEPTED' AND "invitation_id" IS NOT NULL AND "target_membership_id" IS NOT NULL)
);
