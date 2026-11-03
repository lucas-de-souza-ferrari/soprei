-- Um User desativado era um vínculo desativado, não uma conta global banida.
-- Corrige somente o backfill ainda intocado da migration anterior. Alterações globais
-- posteriores (updated_at diferente, confirmação ou código emitido) não são revertidas.
UPDATE accounts a
SET status = 'ACTIVE'
FROM users u
WHERE a.id = u.id AND u.account_id = a.id
  AND a.status = 'DISABLED' AND u.status = 'DISABLED'
  AND a.email_verified_at IS NULL AND a.verification_hash IS NULL
  AND a.created_at = u.created_at::timestamptz
  AND a.updated_at = u.updated_at::timestamptz;
