-- Spec 010: persona do cliente, contactRef da conversa e o model Message (tenant).
-- Migration aditiva. As chaves estrangeiras de messages são COMPOSTAS com client_id: no banco,
-- uma mensagem nunca aponta para conversa nem para mensagem de outro cliente.

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('USER', 'ASSISTANT');

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "persona" TEXT;

-- AlterTable: coluna nova e obrigatória. Se já houvesse conversas, receberiam um valor
-- derivado do id (a spec parte de um banco sem conversas; o backfill só evita falhar).
ALTER TABLE "conversations" ADD COLUMN     "contact_ref" TEXT;
UPDATE "conversations" SET "contact_ref" = 'legacy-' || "id"::text WHERE "contact_ref" IS NULL;
ALTER TABLE "conversations" ALTER COLUMN "contact_ref" SET NOT NULL;

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "external_id" TEXT,
    "reply_to_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_client_id_conversation_id_created_at_id_idx" ON "messages"("client_id", "conversation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_id_client_id_key" ON "messages"("id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_client_id_external_id_key" ON "messages"("client_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_client_id_reply_to_id_key" ON "messages"("client_id", "reply_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_client_id_key" ON "conversations"("id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_client_id_contact_ref_key" ON "conversations"("client_id", "contact_ref");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composta: conversa e mensagem precisam ser do MESMO cliente)
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_client_id_fkey" FOREIGN KEY ("conversation_id", "client_id") REFERENCES "conversations"("id", "client_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey (composta: a resposta e a mensagem do contato são do MESMO cliente)
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_client_id_fkey" FOREIGN KEY ("reply_to_id", "client_id") REFERENCES "messages"("id", "client_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Limites de tamanho também no banco (defesa em profundidade; a validação principal é do Zod).
ALTER TABLE "clients" ADD CONSTRAINT "clients_persona_length_check" CHECK ("persona" IS NULL OR char_length("persona") BETWEEN 1 AND 4000);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_ref_length_check" CHECK (char_length("contact_ref") BETWEEN 1 AND 128);
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_length_check" CHECK (char_length("content") BETWEEN 1 AND 4000);
ALTER TABLE "messages" ADD CONSTRAINT "messages_external_id_length_check" CHECK ("external_id" IS NULL OR char_length("external_id") BETWEEN 1 AND 128);
ALTER TABLE "messages" ADD CONSTRAINT "messages_fallback_role_check" CHECK ("is_fallback" = false OR "role" = 'ASSISTANT');
