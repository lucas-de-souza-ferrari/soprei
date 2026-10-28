-- Spec 013: agrupamento de mensagens rápidas. Migration aditiva (uma coluna opcional, sem backfill).
--  - messages.answered_by_id: na mensagem do CONTATO, a resposta do assistente que a atendeu. Várias
--    mensagens do mesmo lote apontam para a mesma resposta.
--  - "Pendente" = mensagem USER sem answered_by_id E sem resposta por reply_to_id (esta segunda
--    condição cobre o simulador administrativo e as linhas anteriores a esta migration).

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "answered_by_id" UUID;

-- AddForeignKey
-- Composta com client_id: mensagem de um cliente nunca aponta para resposta de outro cliente.
ALTER TABLE "messages" ADD CONSTRAINT "messages_answered_by_id_client_id_fkey" FOREIGN KEY ("answered_by_id", "client_id") REFERENCES "messages"("id", "client_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Só mensagem do contato (USER) é "atendida por" uma resposta.
ALTER TABLE "messages" ADD CONSTRAINT "messages_answered_by_only_user_check" CHECK ("answered_by_id" IS NULL OR "role" = 'USER');

-- Busca de pendentes (mais antigas primeiro) por conversa. Índice parcial: o Prisma não o
-- representa no schema, então ele vive só aqui.
CREATE INDEX "messages_pending_idx" ON "messages"("client_id", "conversation_id", "created_at", "id") WHERE "role" = 'USER' AND "answered_by_id" IS NULL;
