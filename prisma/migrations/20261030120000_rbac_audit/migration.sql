-- Spec 008: papéis ADMIN e VIEWER, FKs compostas e trilha de auditoria.
-- Migration ADITIVA: dois valores novos no enum user_role, um índice único novo em users e a
-- tabela audit_events (mais o tipo audit_action). Nada existente é apagado nem reescrito.

-- AlterEnum (só acrescenta; os valores novos não são usados nesta migration)
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'ADMIN' BEFORE 'AGENT';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'VIEWER';

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('USER_CREATED', 'USER_ROLE_CHANGED', 'USER_DISABLED', 'USER_ENABLED', 'USER_PASSWORD_RESET', 'USER_PASSWORD_CHANGED');

-- CreateIndex: alvo das chaves estrangeiras compostas de audit_events
CREATE UNIQUE INDEX "users_id_client_id_key" ON "users"("id", "client_id");

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "action" "audit_action" NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "from_role" "user_role",
    "to_role" "user_role",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_client_id_created_at_id_idx" ON "audit_events"("client_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (compostas com client_id: a trilha de um cliente nunca aponta para usuário de outro)
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_client_id_fkey" FOREIGN KEY ("actor_user_id", "client_id") REFERENCES "users"("id", "client_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_user_id_client_id_fkey" FOREIGN KEY ("target_user_id", "client_id") REFERENCES "users"("id", "client_id") ON DELETE RESTRICT ON UPDATE CASCADE;
