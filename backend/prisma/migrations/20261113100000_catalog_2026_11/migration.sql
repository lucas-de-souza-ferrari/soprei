-- Spec 040, E1: catálogo novo de planos (decisão do dono, 2026-11-13).
-- Aditiva e compatível com a versão anterior do código (spec 037): só INSERT. As linhas antigas de "plans" e
-- "plan_prices" não são tocadas (o catálogo é append-only; a leitura escolhe a maior versão ativa de cada código).
-- A versão de cada plano novo é a maior existente + 1, calculada aqui (a produção tem versões extras do Essencial).
-- Só o modo "a empresa paga a Meta" (CUSTOMER_PAYS_META): estas cotas não valem no outro modo.
-- valid_from igual ao da semente da 031: quem escolhe a versão é plans.version; uma data posterior deixaria o código
-- sem preço para relógios anteriores ao deploy. A data real fica em created_at.

-- Essencial 2.500 respostas, Profissional 8.000 e Escala 30.000 por mês; tokens = 6.000 por resposta (proteção).
INSERT INTO "plans" ("id", "code", "name", "max_companies", "monthly_tokens", "monthly_replies", "meta_estimate_milli_cents", "version", "active")
SELECT
  gen_random_uuid(),
  v."code"::"plan_code",
  v."name",
  v."max_companies",
  v."monthly_tokens",
  v."monthly_replies",
  3500,
  (SELECT COALESCE(MAX(p."version"), 0) + 1 FROM "plans" p WHERE p."code" = v."code"::"plan_code"),
  true
FROM (VALUES
  ('ESSENTIAL', 'Essencial', 1, 15000000::bigint, 2500),
  ('PROFESSIONAL', 'Profissional', 3, 48000000::bigint, 8000),
  ('SCALE', 'Escala', 10, 180000000::bigint, 30000)
) AS v("code", "name", "max_companies", "monthly_tokens", "monthly_replies");

-- Preços em centavos: mensal 47,90 / 119,90 / 349,00; anual = 10 x o mensal, para o plano e para os módulos.
INSERT INTO "plan_prices" ("id", "plan_id", "cycle", "base_cents", "agenda_cents", "stock_cents", "whatsapp_billing_mode", "meta_per_reply_milli_cents", "extra_pack_cents", "extra_pack_replies", "version", "valid_from")
SELECT gen_random_uuid(), p."id", v."cycle"::"billing_cycle", v."base", v."agenda", v."stock", 'CUSTOMER_PAYS_META', 3500, 5900, 500, 1, TIMESTAMPTZ '2026-11-01 00:00:00+00'
FROM "plans" p
JOIN (VALUES
  ('ESSENTIAL', 'MONTHLY', 4790, 2900, 1900),
  ('ESSENTIAL', 'ANNUAL', 47900, 29000, 19000),
  ('PROFESSIONAL', 'MONTHLY', 11990, 4900, 3900),
  ('PROFESSIONAL', 'ANNUAL', 119900, 49000, 39000),
  ('SCALE', 'MONTHLY', 34900, 9900, 7900),
  ('SCALE', 'ANNUAL', 349000, 99000, 79000)
) AS v("code", "cycle", "base", "agenda", "stock") ON v."code"::"plan_code" = p."code"
WHERE p."version" = (SELECT MAX(q."version") FROM "plans" q WHERE q."code" = p."code");
