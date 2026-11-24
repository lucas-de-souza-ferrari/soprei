-- Spec 035 (revisão, I4): resposta do assistente que a Meta aceitou (2xx) mas devolveu sem id legível.
-- Provavelmente entregue ao contato: a retomada nunca a reenvia (decisão da spec 011, mantida pelo dono).
-- Aditiva e compatível com a versão anterior do código (coluna anulável, que o código antigo ignora).
ALTER TABLE "messages" ADD COLUMN "delivery_uncertain_at" TIMESTAMP(3);

ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_uncertain_only_assistant_check" CHECK ("delivery_uncertain_at" IS NULL OR "role" = 'ASSISTANT');
