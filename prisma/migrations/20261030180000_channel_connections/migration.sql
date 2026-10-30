-- Spec 015: credencial do canal WhatsApp por cliente.
-- Migration ADITIVA: tabela nova, três valores novos em audit_action e `target_user_id` anulável.
-- Nada é apagado nem reescrito; nenhum token é cifrado aqui (não há chave no SQL) e o número dos
-- clientes existentes (`clients.whatsapp_phone_number_id`) não é tocado.

-- AlterEnum (só acrescenta; os valores novos não são usados nesta migration, nem no CHECK abaixo)
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'CHANNEL_CONNECTED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'CHANNEL_TOKEN_REPLACED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'CHANNEL_DISCONNECTED';

-- CreateEnum
CREATE TYPE "channel_connection_status" AS ENUM ('CONNECTED', 'TOKEN_INVALID');

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "status" "channel_connection_status" NOT NULL DEFAULT 'CONNECTED',
    "token_expires_at" TIMESTAMP(3),
    "token_invalid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (no máximo uma conexão por cliente)
CREATE UNIQUE INDEX "channel_connections_client_id_key" ON "channel_connections"("client_id");

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Formato do id da WABA (dígitos) como defesa em profundidade.
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_waba_id_check" CHECK ("waba_id" ~ '^[0-9]{1,32}$');

-- AlterTable: o alvo deixa de ser obrigatório (eventos de canal não têm usuário alvo).
ALTER TABLE "audit_events" ALTER COLUMN "target_user_id" DROP NOT NULL;

-- CHECK por ação: USER_* exige alvo; CHANNEL_* exige alvo nulo. Compara pelo texto da ação (o valor
-- de enum recém-acrescentado não pode ser usado na mesma transação).
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_by_action_check" CHECK (
    ("action"::text LIKE 'USER\_%' AND "target_user_id" IS NOT NULL)
    OR ("action"::text LIKE 'CHANNEL\_%' AND "target_user_id" IS NULL)
);
