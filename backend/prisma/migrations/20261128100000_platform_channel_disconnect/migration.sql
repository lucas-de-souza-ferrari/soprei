-- Spec 045, E5: o admin da plataforma desconecta o WhatsApp de uma empresa (ou libera o número de uma empresa
-- LEGACY). Aditiva e compatível com a versão anterior do código: só um valor novo no enum da trilha da
-- plataforma (a versão anterior nunca o grava nem o lê). Nada é apagado, renomeado nem reescrito.
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'CHANNEL_DISCONNECTED_BY_PLATFORM';
