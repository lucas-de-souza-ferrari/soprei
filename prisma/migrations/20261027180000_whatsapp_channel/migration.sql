-- Spec 011: canal WhatsApp. Migration aditiva (só colunas novas, todas opcionais).
--  - clients.whatsapp_phone_number_id: o phone_number_id da Meta deste cliente (único).
--  - messages.channel_message_id / sent_at: marca de envio da resposta do assistente.

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "whatsapp_phone_number_id" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "channel_message_id" TEXT,
ADD COLUMN     "sent_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "clients_whatsapp_phone_number_id_key" ON "clients"("whatsapp_phone_number_id");

-- Formato e tamanho também no banco (defesa em profundidade; a validação principal é do Zod).
ALTER TABLE "clients" ADD CONSTRAINT "clients_whatsapp_phone_number_id_format_check" CHECK ("whatsapp_phone_number_id" IS NULL OR "whatsapp_phone_number_id" ~ '^[0-9]{1,32}$');
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_message_id_length_check" CHECK ("channel_message_id" IS NULL OR char_length("channel_message_id") BETWEEN 1 AND 128);
-- A marca de envio só existe em resposta do assistente.
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_only_assistant_check" CHECK (("sent_at" IS NULL AND "channel_message_id" IS NULL) OR "role" = 'ASSISTANT');
