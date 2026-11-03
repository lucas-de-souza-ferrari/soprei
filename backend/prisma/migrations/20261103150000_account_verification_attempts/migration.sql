-- Spec 020: código de confirmação de 6 dígitos. Aditiva: três colunas e uma regra de integridade
-- mais frouxa (o código esgotado guarda o vencimento para o intervalo de reenvio continuar valendo).

-- Erros do código vigente (zera a cada código novo e ao confirmar) e erros acumulados na janela
-- de 24 h (não zera com reenvio; só ao confirmar ou quando a janela, aberta no primeiro erro, passa).
ALTER TABLE accounts
  ADD COLUMN verification_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN verification_failures_day smallint NOT NULL DEFAULT 0,
  ADD COLUMN verification_failures_since timestamptz,
  ADD CONSTRAINT account_verification_counters_check CHECK
    (verification_attempts >= 0 AND verification_failures_day >= 0);

-- Antes: hash e vencimento nulos juntos. Agora o código esgotado fica sem hash e com vencimento.
ALTER TABLE accounts DROP CONSTRAINT account_verification_pair;
ALTER TABLE accounts ADD CONSTRAINT account_verification_expiry CHECK
  (verification_hash IS NULL OR verification_expires_at IS NOT NULL);

-- Códigos pendentes antigos (SHA-256 do token longo) nunca mais conferem: o HMAC é outro. Zera
-- só as contas não confirmadas; as confirmadas não mudam. O reenvio fica liberado na hora.
UPDATE accounts
SET verification_hash = NULL, verification_expires_at = NULL
WHERE email_verified_at IS NULL;
