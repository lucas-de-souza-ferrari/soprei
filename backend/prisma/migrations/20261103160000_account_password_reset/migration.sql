-- Spec 021: recuperação de senha e expurgo de contas não confirmadas. Aditiva: cinco colunas, dois
-- CHECKs e um índice parcial; nenhuma coluna ou dado existente muda.

-- Código de recuperação de senha (HMAC com finalidade própria), separado do de confirmação de
-- e-mail. Um código pendente por conta; `reset_attempts` zera a cada código novo; os erros do dia
-- (`reset_failures_day`, janela aberta em `reset_failures_since`) só zeram ao redefinir ou quando
-- a janela de 24 h passa.
ALTER TABLE accounts
  ADD COLUMN reset_hash text,
  ADD COLUMN reset_expires_at timestamptz,
  ADD COLUMN reset_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN reset_failures_day smallint NOT NULL DEFAULT 0,
  ADD COLUMN reset_failures_since timestamptz,
  ADD CONSTRAINT account_reset_counters_check CHECK
    (reset_attempts >= 0 AND reset_failures_day >= 0),
  ADD CONSTRAINT account_reset_expiry CHECK
    (reset_hash IS NULL OR reset_expires_at IS NOT NULL);

-- Expurgo de contas não confirmadas: o índice parcial atende a varredura por `updated_at` (o
-- Prisma não representa índice parcial; ele existe só aqui).
CREATE INDEX accounts_unverified_updated_at_idx ON accounts (updated_at)
  WHERE email_verified_at IS NULL;
