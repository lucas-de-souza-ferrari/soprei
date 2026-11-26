-- Spec 045, E6: o admin da plataforma remove uma conta por anonimização (os efeitos da spec 032, E7). Aditiva e
-- compatível com a versão anterior do código: só um valor novo no enum da trilha da plataforma (a versão anterior
-- nunca o grava nem o lê). Nada é apagado, renomeado nem reescrito.
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_ANONYMIZED';
