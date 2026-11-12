-- Spec 039: conexão do WhatsApp por coexistência (o número segue no aplicativo WhatsApp Business) e
-- pausa da IA quando a equipe responde pelo celular.
-- Migration ADITIVA e compatível com a versão anterior do código (regra da spec 037): um enum novo, um
-- valor novo em enum existente, uma coluna NOT NULL com DEFAULT, duas colunas anuláveis e um índice.
-- Nada é apagado nem reescrito.
--
-- ATENÇÃO (rollback do deploy, spec 037): a versão anterior do código não conhece o valor 'HUMAN' de
-- message_role e falha ao LER uma mensagem com ele. Nenhuma linha 'HUMAN' é gravada enquanto
-- WHATSAPP_COEXISTENCE_ENABLED estiver desligada (o eco só é tratado com ela ligada). Depois de ligar e do
-- primeiro eco gravado, não volte o código para antes desta versão (ver docs/ops/deploy.md).

-- CreateEnum
CREATE TYPE "channel_connection_mode" AS ENUM ('API_ONLY', 'COEXISTENCE');

-- AlterEnum (o valor novo não é usado nesta migration: valor de enum novo não pode ser usado na mesma
-- transação em que foi criado)
ALTER TYPE "message_role" ADD VALUE 'HUMAN';

-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN "mode" "channel_connection_mode" NOT NULL DEFAULT 'API_ONLY';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "ai_ignore_before" TIMESTAMP(3),
ADD COLUMN "ai_paused_until" TIMESTAMP(3);

-- CreateIndex (reconhecer o eco de uma resposta nossa pelo id que o envio devolveu; só defesa, spec 039 S8)
CREATE INDEX "messages_company_id_channel_message_id_idx" ON "messages"("company_id", "channel_message_id");
