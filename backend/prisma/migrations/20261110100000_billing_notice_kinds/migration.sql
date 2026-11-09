-- Spec 031 (E5): novos tipos de aviso por e-mail ao titular da assinatura. Aditiva: so acrescenta valores ao
-- enum; a chave unica (subscription_id, kind, window_start) de payment_notices ja garante um aviso por tipo e janela.
ALTER TYPE "payment_notice_kind" ADD VALUE IF NOT EXISTS 'PERIOD_GRACE_ENDED';
ALTER TYPE "payment_notice_kind" ADD VALUE IF NOT EXISTS 'PAYMENT_RECEIVED';
ALTER TYPE "payment_notice_kind" ADD VALUE IF NOT EXISTS 'PLAN_CHANGE_APPLIED';
ALTER TYPE "payment_notice_kind" ADD VALUE IF NOT EXISTS 'DOWNGRADE_BLOCKED';
ALTER TYPE "payment_notice_kind" ADD VALUE IF NOT EXISTS 'TRIAL_ENDING';
ALTER TYPE "payment_notice_kind" ADD VALUE IF NOT EXISTS 'TRIAL_ENDED';
