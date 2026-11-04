-- Spec 024: ordem da lista de conversas por última atividade. Aditiva: um índice e um UPDATE de
-- correção de dado derivado; nenhuma coluna ou linha é criada, apagada ou renomeada.

-- A partir daqui o repositório de mensagens leva `conversations.updated_at` até o `created_at` de
-- cada mensagem gravada. Para as conversas que já existem, `updated_at` nunca foi tocado (ficou na
-- data da criação): leva-o à data da última mensagem. Conversa sem mensagem não muda.
UPDATE conversations AS c
SET updated_at = last_message.last_at
FROM (
  SELECT conversation_id, company_id, MAX(created_at) AS last_at
  FROM messages
  GROUP BY conversation_id, company_id
) AS last_message
WHERE last_message.conversation_id = c.id
  AND last_message.company_id = c.company_id;

-- Lista do painel: `company_id` fixo, `updated_at` e `id` decrescentes.
CREATE INDEX "conversations_company_id_updated_at_id_idx"
  ON "conversations"("company_id", "updated_at", "id");
