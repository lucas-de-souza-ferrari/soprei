-- Spec 022: renome do domínio. `Client` (a empresa, o tenant) vira `Company` e `User` (o vínculo de
-- uma conta com uma empresa) vira `Membership`. Só metadado: ALTER ... RENAME preserva os dados e
-- não reescreve nenhuma tabela. Nenhuma constraint é recriada (as chaves estrangeiras compostas e os
-- únicos `(id, company_id)` seguem valendo durante todo o renome), com uma exceção: o CHECK por ação
-- de `audit_events` compara o TEXTO do valor do enum e por isso é recriado com o prefixo novo.
-- O Prisma executa o arquivo inteiro como um lote atômico: se qualquer passo falhar (inclusive a
-- verificação final), nada fica pela metade. Sem BEGIN/COMMIT próprios, de propósito.
-- O servidor e o worker precisam estar parados enquanto ela é aplicada (ACCESS EXCLUSIVE breve).

-- 1. O CHECK por ação cita colunas e o texto 'USER\_%': sai agora e volta no passo 6.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_target_by_action_check;

-- 2. Tipos e valores de enum. `user_status` é compartilhado por accounts, platform_admins e
-- memberships: o nome novo não é de vínculo (`access_status`).
ALTER TYPE client_status RENAME TO company_status;
ALTER TYPE user_role RENAME TO membership_role;
ALTER TYPE user_status RENAME TO access_status;
ALTER TYPE audit_action RENAME VALUE 'USER_CREATED' TO 'MEMBERSHIP_CREATED';
ALTER TYPE audit_action RENAME VALUE 'USER_ROLE_CHANGED' TO 'MEMBERSHIP_ROLE_CHANGED';
ALTER TYPE audit_action RENAME VALUE 'USER_DISABLED' TO 'MEMBERSHIP_DISABLED';
ALTER TYPE audit_action RENAME VALUE 'USER_ENABLED' TO 'MEMBERSHIP_ENABLED';
ALTER TYPE audit_action RENAME VALUE 'USER_PASSWORD_RESET' TO 'MEMBERSHIP_PASSWORD_RESET';
ALTER TYPE audit_action RENAME VALUE 'USER_PASSWORD_CHANGED' TO 'MEMBERSHIP_PASSWORD_CHANGED';

-- 3. Tabelas.
ALTER TABLE clients RENAME TO companies;
ALTER TABLE users RENAME TO memberships;

-- 4. Colunas.
ALTER TABLE conversations RENAME COLUMN client_id TO company_id;
ALTER TABLE messages RENAME COLUMN client_id TO company_id;
ALTER TABLE memberships RENAME COLUMN client_id TO company_id;
ALTER TABLE audit_events RENAME COLUMN client_id TO company_id;
ALTER TABLE audit_events RENAME COLUMN actor_user_id TO actor_membership_id;
ALTER TABLE audit_events RENAME COLUMN target_user_id TO target_membership_id;
ALTER TABLE channel_connections RENAME COLUMN client_id TO company_id;

-- 5. Chaves primárias, chaves estrangeiras, CHECKs e índices: o nome que o Prisma gera a partir do
-- schema novo (senão o `prisma migrate dev` enxerga drift).
ALTER TABLE companies RENAME CONSTRAINT clients_pkey TO companies_pkey;
ALTER TABLE memberships RENAME CONSTRAINT users_pkey TO memberships_pkey;

ALTER TABLE memberships RENAME CONSTRAINT users_client_id_fkey TO memberships_company_id_fkey;
ALTER TABLE memberships RENAME CONSTRAINT users_account_id_fkey TO memberships_account_id_fkey;
ALTER TABLE conversations RENAME CONSTRAINT conversations_client_id_fkey TO conversations_company_id_fkey;
ALTER TABLE messages RENAME CONSTRAINT messages_client_id_fkey TO messages_company_id_fkey;
ALTER TABLE messages RENAME CONSTRAINT messages_conversation_id_client_id_fkey TO messages_conversation_id_company_id_fkey;
ALTER TABLE messages RENAME CONSTRAINT messages_reply_to_id_client_id_fkey TO messages_reply_to_id_company_id_fkey;
ALTER TABLE messages RENAME CONSTRAINT messages_answered_by_id_client_id_fkey TO messages_answered_by_id_company_id_fkey;
ALTER TABLE audit_events RENAME CONSTRAINT audit_events_client_id_fkey TO audit_events_company_id_fkey;
ALTER TABLE audit_events RENAME CONSTRAINT audit_events_actor_user_id_client_id_fkey TO audit_events_actor_membership_id_company_id_fkey;
ALTER TABLE audit_events RENAME CONSTRAINT audit_events_target_user_id_client_id_fkey TO audit_events_target_membership_id_company_id_fkey;
ALTER TABLE channel_connections RENAME CONSTRAINT channel_connections_client_id_fkey TO channel_connections_company_id_fkey;

ALTER TABLE companies RENAME CONSTRAINT clients_persona_length_check TO companies_persona_length_check;
ALTER TABLE companies RENAME CONSTRAINT clients_whatsapp_phone_number_id_format_check TO companies_whatsapp_phone_number_id_format_check;
ALTER TABLE messages RENAME CONSTRAINT messages_answered_by_only_user_check TO messages_answered_by_only_contact_check;

ALTER INDEX clients_slug_key RENAME TO companies_slug_key;
ALTER INDEX clients_whatsapp_phone_number_id_key RENAME TO companies_whatsapp_phone_number_id_key;
ALTER INDEX conversations_client_id_contact_ref_key RENAME TO conversations_company_id_contact_ref_key;
ALTER INDEX conversations_id_client_id_key RENAME TO conversations_id_company_id_key;
ALTER INDEX conversations_client_id_created_at_id_idx RENAME TO conversations_company_id_created_at_id_idx;
ALTER INDEX messages_id_client_id_key RENAME TO messages_id_company_id_key;
ALTER INDEX messages_client_id_external_id_key RENAME TO messages_company_id_external_id_key;
ALTER INDEX messages_client_id_reply_to_id_key RENAME TO messages_company_id_reply_to_id_key;
ALTER INDEX messages_client_id_conversation_id_created_at_id_idx RENAME TO messages_company_id_conversation_id_created_at_id_idx;
ALTER INDEX users_id_client_id_key RENAME TO memberships_id_company_id_key;
ALTER INDEX users_client_id_email_key RENAME TO memberships_company_id_email_key;
ALTER INDEX users_client_id_account_id_key RENAME TO memberships_company_id_account_id_key;
ALTER INDEX users_client_id_created_at_id_idx RENAME TO memberships_company_id_created_at_id_idx;
ALTER INDEX audit_events_client_id_created_at_id_idx RENAME TO audit_events_company_id_created_at_id_idx;
ALTER INDEX channel_connections_client_id_key RENAME TO channel_connections_company_id_key;

-- PostgreSQL 18 passou a registrar os NOT NULL como constraints nomeadas `<tabela>_<coluna>_not_null`
-- e não as renomeia junto com a tabela ou a coluna. Nas versões anteriores o laço não acha nada.
DO $$
DECLARE
  item record;
  new_name text;
BEGIN
  FOR item IN
    SELECT c.conrelid::regclass::text AS table_name, c.conname
    FROM pg_constraint c
    WHERE c.connamespace = current_schema()::regnamespace
      AND c.contype = 'n'
      AND c.conname ~ '(client|user)'
  LOOP
    new_name := replace(replace(replace(replace(item.conname,
      'clients', 'companies'), 'users', 'memberships'), 'client_id', 'company_id'), 'user_id', 'membership_id');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', item.table_name, item.conname, new_name);
  END LOOP;
END
$$;

-- 6. O CHECK por ação, com o prefixo novo: ação de vínculo exige alvo, ação de canal exige nulo.
ALTER TABLE audit_events ADD CONSTRAINT audit_events_target_by_action_check CHECK (
  (action::text LIKE 'MEMBERSHIP\_%' AND target_membership_id IS NOT NULL)
  OR (action::text LIKE 'CHANNEL\_%' AND target_membership_id IS NULL)
);

-- 7. PREFLIGHT: a migration inteira falha se sobrar algum nome antigo no schema atual (tabela,
-- coluna, tipo, índice, constraint ou valor de audit_action).
DO $$
DECLARE
  leftovers text;
BEGIN
  SELECT string_agg(leftover.item_name, ', ' ORDER BY leftover.item_name) INTO leftovers FROM (
    SELECT 'relation ' || c.relname AS item_name
      FROM pg_class c
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relname ~* '(client|user)'
    UNION ALL
    SELECT 'column ' || c.relname || '.' || a.attname
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* '(client|user)'
    UNION ALL
    SELECT 'type ' || t.typname
      FROM pg_type t
      WHERE t.typnamespace = current_schema()::regnamespace AND t.typname ~* '(client|user)'
    UNION ALL
    SELECT 'constraint ' || c.conname
      FROM pg_constraint c
      WHERE c.connamespace = current_schema()::regnamespace AND c.conname ~* '(client|user)'
    UNION ALL
    SELECT 'enum value ' || e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typnamespace = current_schema()::regnamespace AND t.typname = 'audit_action'
        AND e.enumlabel ~* '(client|user)'
  ) AS leftover;
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION 'RENAME_LEFTOVERS: %', leftovers;
  END IF;
END
$$;
