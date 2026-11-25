-- Spec 045, E2: ações do admin da plataforma sobre contas (desativar, reativar, encerrar sessões, enviar
-- código de recuperação de senha e reenviar código de confirmação). Aditiva: só acrescenta valores ao enum
-- da trilha da plataforma; nada é apagado, renomeado nem reescrito.
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_DISABLED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_ENABLED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_SESSIONS_REVOKED';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_PASSWORD_RESET_SENT';
ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_VERIFICATION_SENT';
