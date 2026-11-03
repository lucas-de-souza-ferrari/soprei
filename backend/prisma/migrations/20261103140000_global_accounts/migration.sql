-- Colisão é por e-mail em minúsculas (a conta global guarda o e-mail normalizado).
-- A migração não resolve titularidade por coincidência de e-mail.
-- Rever o relatório de colisões antes de aplicar; nunca escolher uma das senhas arbitrariamente.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ACCOUNT_EMAIL_COLLISIONS: resolva explicitamente as contas repetidas antes da migration';
  END IF;
END $$;

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  email_verified_at timestamptz,
  verification_hash text,
  verification_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT account_verification_pair CHECK
    ((verification_hash IS NULL) = (verification_expires_at IS NULL))
);

-- Preserva a senha da identidade única existente; titularidade ainda exigirá confirmação de e-mail.
INSERT INTO accounts (id, email, password_hash, status, created_at, updated_at)
SELECT id, lower(email), password_hash, status, created_at, updated_at FROM users;

ALTER TABLE users ADD COLUMN account_id uuid;
UPDATE users SET account_id = id;
ALTER TABLE users ADD CONSTRAINT users_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX users_client_id_account_id_key ON users(client_id, account_id);
