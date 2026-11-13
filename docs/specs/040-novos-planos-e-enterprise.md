# 040 — Novo catálogo de planos, cota de tokens fora da tela e plano Enterprise por contato

- **Status:** aprovada (dono, 2026-11-13: todas as recomendações D1 a D18)
- **Branch:** `spec/040-novos-planos` (uma branch por etapa, se o dono preferir PRs menores: `spec/040-e1-catalogo`, `spec/040-e2-tela`, `spec/040-e3-politica`, `spec/040-e4-contato`)
- **Depende de:** 031 (planos e assinaturas, E1 a E5 em produção), 017 e 019 (contas e SMTP), 005 (rate limit), 032 (páginas legais), 037 (deploy: migration aditiva e compatível com a versão anterior)
- **Revisão:** passa pelo `reviewer` antes do merge (dinheiro, transição de assinaturas pagas e **endpoint público novo** que envia e-mail).
- **Numeração:** conferido em `docs/specs/` (existem até a 039; a 035 está reservada para "eficiência do turno"); não há 040.

## Objetivo

O dono decidiu um catálogo novo, mais barato na entrada e com muito mais respostas incluídas, e um quarto plano, **Enterprise**, vendido só por contato. Como a cobrança já está ligada em produção (`BILLING_ENABLED` e `CHECKOUT_ENABLED`), a troca precisa respeitar o catálogo versionado e append-only da 031, não prejudicar quem já assina e não depender de editar linha antiga. A cota de tokens continua como proteção de custo, mas sai da tela: o cliente passa a ver só respostas.

## Estado atual (lido no código)

- **Catálogo** (`backend/prisma/schema.prisma`, models `Plan` e `PlanPrice`; sementes em `prisma/migrations/20261109100000_plans_subscriptions/migration.sql`): `Plan` tem `code`, `maxCompanies`, `monthlyTokens`, `monthlyReplies`, `metaEstimateMilliCents`, `version` (`@@unique([code, version])`) e `active`; `PlanPrice` pertence a **uma linha de `Plan`** (`planId`), com `cycle`, `baseCents`, `agendaCents`, `stockCents`, `whatsappBillingMode`, `version` (`@@unique([planId, cycle, whatsappBillingMode, version])`) e `validFrom`. Semente atual (versão 1, modo C): 59/149/349 mensais, anual = 12 x 0,8 (566,40; 1.430,40; 3.350,40), módulos 29/49/99 e 19/39/79 (anuais 278,40/470,40/950,40 e 182,40/374,40/758,40), cotas 800/3.200/10.800 respostas e 3 M/12 M/40 M tokens (3.750 tokens por resposta), estimativa da Meta 3.500 milésimos de centavo, pacote extra 5.900/500 (o pacote, E6, não existe).
- **Leitura do catálogo** (`infrastructure/database/repositories/billing.repository.ts`, `PrismaBillingRepository.catalog`): por código, a **maior `version` ativa** de `Plan`; dentro dela, por ciclo, o `PlanPrice` de maior `version` com `validFrom <= now` (e só modo C sem `SOPREI_PAYS_META_ENABLED`). O teste gratuito (`ensureTrialSubscription`) usa a mesma regra para o Essencial mensal. **Atenção:** se a maior versão de um código não tiver preço vigente em `now`, o código fica sem preço ("Plano indisponível"); por isso `valid_from` das linhas novas não pode ser posterior ao relógio de nenhum teste nem ao deploy.
- **Assinatura** (`Subscription`): aponta para **uma linha** de `Plan` (`planId`) e uma de `PlanPrice` (`priceId`). As **cotas** saem de `subscription.plan` (`domain/billing.ts`, `quotaLimits`: no teste, tokens = `BILLING_TRIAL_TOKENS` e respostas = cota do plano; fora dele, as do plano), usadas por `buildEntitlements` (IA e gate), `BillingService.overview` (`GET /account/billing`) e `dueNotices` (`domain/billing-notices.ts`, e-mails de 80% e 100%). Os loaders são `findSubscriptionByAccount`/`findSubscriptionById` (`billing.repository.ts`) e o `include` de `billing-notice.repository.ts`, todos por `toSubscription`.
- **Renovação e pedidos** (`application/billing/checkout.service.ts`): todo pedido (`NEW`, `RENEWAL`, `UPGRADE`) lê o **catálogo vigente na criação** e copia `priceId`/`priceVersion` no `breakdown`. A concessão (`checkout.repository.ts`, `grantPaidOrder`) grava `planId = price.planId` e `priceId = price.id` **do pedido**; as comparações de "plano ainda é o mesmo" usam só `plan.code`, ciclo e módulos. Logo: **o preço novo já vale sozinho na próxima renovação**, mas um pedido criado **antes** da troca e pago **depois** grava a linha antiga de `Plan` (cotas antigas) e cobra o valor antigo. O upgrade proporcional (`prorateUpgradeCents`) usa `sub.price` (o que a pessoa pagou) contra o preço do catálogo vigente.
- **Produção tem linhas extras no catálogo:** o teste real da InfinitePay (2026-11-11) criou uma "versão 2" do Essencial a R$ 1,00, neutralizada por uma "versão 3" no banco do servidor (`docs/handoff.md`; não está registrado se são versões de `Plan` ou de `PlanPrice`). **A migration desta spec não pode fixar números de versão.**
- **Tokens na tela** (`frontend/src/company/SubscriptionPage.tsx`): barra "Uso da IA" em tokens, texto "Vale a cota que acabar primeiro", alerta "Cota do mês esgotada" também por tokens; `billing-rules.ts` (`accessNotice`, por volta da linha 370) usa `tokensFull`. E-mails `QUOTA_TOKENS_80` e `QUOTA_TOKENS_100` (`application/billing/billing-mail.ts`, assuntos "Você já usou 80% da cota de IA..." e "A cota de IA do seu plano do Soprei acabou"). O enum `payment_notice_kind` já tem `PRICE_CHANGE`, **nunca usado**.
- **Página pública de preços:** **não existe.** A página inicial (`frontend/src/App.tsx`) não mostra planos; os planos só aparecem na aba "Planos" de `/painel/assinatura`, para a conta titular e com o checkout ligado. `main.tsx` monta `App` (página inicial) fora de `ACCOUNT_PATHS` e de `/painel`.
- **SMTP** (`infrastructure/config/env.schema.ts`, `config/email.ts`, `external-apis/email/smtp-verification-mailer.ts`): `EMAIL_PROVIDER_FROM` é **só o endereço** (validado com `z.email()`; o nome "Soprei" é fixo no código), então não há "Nome <e-mail>" a interpretar. Envio por `nodemailer`, texto simples, erro fixo sem eco. O `.env.example` traz `noreply@...` como exemplo, e em produção é um Gmail.
- **Rate limit** (`shared/rate-limit/profiles.ts`): perfis `public`, `admin`, `webhook`, `login` e `refresh`; `login` e `refresh` são fail-closed. O `login` é **um contador por IP compartilhado** por todas as rotas de cadastro e entrada (10 por 15 min).
- **CSRF das rotas públicas da conta** (`presentation/auth/account.controller.ts`): hook `onRequest` que recusa `Origin` diferente de `APP_ORIGIN` ou sem `X-Soprei-App: web`.
- **Termos de uso vigentes** (`frontend/src/legal/termos.md`, seção 7): "Os preços podem mudar. Avisaremos por e-mail com pelo menos 30 dias de antecedência; o novo preço só vale a partir da renovação seguinte". **Política de Privacidade vigente** (`frontend/src/legal/privacidade.md`, versão 1, 2026-11-12): não prevê dados de interessados nem contato comercial.

## O catálogo novo (D1, DECIDIDO pelo dono)

Modo `CUSTOMER_PAYS_META` (a empresa paga a Meta direto). Centavos no banco; reais aqui. **Anual = 10 x o mensal** (dois meses de desconto), para plano **e** módulos.

| Plano | Empresas | Respostas por mês | Tokens por mês (proteção, D2) | Mensal | Anual | Agenda (mês / ano) | Estoque (mês / ano) |
| --- | :-: | :-: | :-: | --: | --: | --: | --: |
| Essencial | 1 | 3.000 | 18 M | R$ 47,90 | R$ 479,00 | R$ 29 / R$ 290 | R$ 19 / R$ 190 |
| Profissional | 3 | 10.000 | 60 M | R$ 119,90 | R$ 1.199,00 | R$ 49 / R$ 490 | R$ 39 / R$ 390 |
| Escala | 10 | 40.000 | 240 M | R$ 349,00 | R$ 3.490,00 | R$ 99 / R$ 990 | R$ 79 / R$ 790 |
| Enterprise | sob consulta | sob consulta | — | — | — | — | — |

Colunas que não mudam: `metaEstimateMilliCents` e `metaPerReplyMilliCents` = 3.500; `extraPackCents` = 5.900 e `extraPackReplies` = 500 (copiados; o pacote continua sem existir). O Enterprise **não** é linha do catálogo (ver D10).

**Efeito "batata do McDonald's" (regra do catálogo, com teste):** o preço por resposta incluída **cai a cada degrau**, no mensal e no anual.

| Plano | Mensal por resposta | Anual por resposta (12 meses de cota) |
| --- | --: | --: |
| Essencial | R$ 0,0160 (47,90 / 3.000) | R$ 0,0133 (479 / 36.000) |
| Profissional | R$ 0,0120 (119,90 / 10.000) | R$ 0,0100 (1.199 / 120.000) |
| Escala | R$ 0,0087 (349 / 40.000) | R$ 0,0073 (3.490 / 480.000) |

**O que muda em relação a hoje (para o dono conferir):** o mensal cai no Essencial (-18,8%) e no Profissional (-19,5%) e fica igual no Escala e nos módulos. **O anual não cai em tudo:** com 10 x em vez de 12 x 0,8 = 9,6 x, o **Escala anual sobe de R$ 3.350,40 para R$ 3.490,00 (+4,2%)** e **todos os módulos anuais sobem 4,2%** (Agenda 278,40 -> 290, 470,40 -> 490, 950,40 -> 990; Estoque 182,40 -> 190, 374,40 -> 390, 758,40 -> 790); Essencial anual cai de 566,40 para 479 e Profissional anual de 1.430,40 para 1.199. Isso aciona a cláusula de reajuste dos termos (ver D6).

**Aviso registrado (decisão do dono):** essas cotas **só valem no modo C**. No modo S (`SOPREI_PAYS_META`, spec 031), com a Meta a ~R$ 0,035 por resposta, só a Meta custaria R$ 105, R$ 350 e R$ 1.400 por mês nos três planos (acima de todos os preços). O modo S continua desligado (`SOPREI_PAYS_META_ENABLED=false`) e, se um dia for ligado, precisa de **catálogo próprio** em spec própria. A migration desta spec **não** cria preço `SOPREI_PAYS_META`, e um teste garante que a versão nova do catálogo não tem linha nesse modo.

## Margem (contas conferidas; premissas da 031)

**Premissas (as mesmas que o dono aceitou):** pior caso = cota de respostas 100% usada todo mês, custo de IA de **R$ 0,006 por resposta** (folga de ~2,4 x sobre os ~3.700 tokens típicos; S1 e S2 da 031 seguem não confirmados), cartão 3,5% (pior caso; Pix 0%), imposto 6%, infraestrutura **R$ 3 por empresa por mês com todas as empresas do plano criadas** (chute). Caso esperado = **R$ 0,0025 por resposta**, o resto igual. Taxa e imposto incidem sobre a receita (inclusive módulos). Módulos não têm custo próprio além desses (a IA da agenda já está dentro do custo por resposta e do teto de tokens, D2).

**Mensal**

| Plano (mensal) | Receita | IA (pior) | Cartão | Imposto | Infra | Custo | Margem pior caso | Margem esperada (IA a 0,0025) |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Essencial | 47,90 | 18,00 | 1,68 | 2,87 | 3 | 25,55 | **R$ 22,35 (46,7%)** | R$ 32,85 (68,6%) |
| Essencial + Agenda + Estoque | 95,90 | 18,00 | 3,36 | 5,75 | 3 | 30,11 | R$ 65,79 (68,6%) | R$ 76,29 (79,6%) |
| Profissional | 119,90 | 60,00 | 4,20 | 7,19 | 9 | 80,39 | **R$ 39,51 (33,0%)** | R$ 74,51 (62,1%) |
| Profissional + Agenda + Estoque | 207,90 | 60,00 | 7,28 | 12,47 | 9 | 88,75 | R$ 119,15 (57,3%) | R$ 154,15 (74,1%) |
| Escala | 349,00 | 240,00 | 12,22 | 20,94 | 30 | 303,16 | **R$ 45,85 (13,1%)** | R$ 185,85 (53,3%) |
| Escala + Agenda + Estoque | 527,00 | 240,00 | 18,45 | 31,62 | 30 | 320,07 | R$ 206,94 (39,3%) | R$ 346,94 (65,8%) |

(O Escala dá R$ 45,845 exatos; o dono anotou 45,84 e 185,84, diferença só de arredondamento.)

**Anual** (receita = 10 x o mensal; custos de IA e infra x 12; taxa e imposto sobre o valor pago)

| Plano (anual) | Receita | IA (pior) | Cartão | Imposto | Infra | Custo | Margem pior caso | Margem esperada (IA a 0,0025) |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Essencial | 479,00 | 216,00 | 16,77 | 28,74 | 36 | 297,51 | R$ 181,50 (37,9%) | R$ 307,50 (64,2%) |
| Essencial + Agenda + Estoque | 959,00 | 216,00 | 33,57 | 57,54 | 36 | 343,11 | R$ 615,90 (64,2%) | R$ 741,90 (77,4%) |
| Profissional | 1.199,00 | 720,00 | 41,97 | 71,94 | 108 | 941,91 | R$ 257,10 (21,4%) | R$ 677,10 (56,5%) |
| Profissional + Agenda + Estoque | 2.079,00 | 720,00 | 72,77 | 124,74 | 108 | 1.025,51 | R$ 1.053,50 (50,7%) | R$ 1.473,50 (70,9%) |
| Escala | 3.490,00 | 2.880,00 | 122,15 | 209,40 | 360 | 3.571,55 | **-R$ 81,55 (-2,3%)** | R$ 1.598,45 (45,8%) |
| Escala + Agenda + Estoque | 5.270,00 | 2.880,00 | 184,45 | 316,20 | 360 | 3.740,65 | R$ 1.529,35 (29,0%) | R$ 3.209,35 (60,9%) |

**Ponto de equilíbrio do custo de IA por resposta** (sem módulos, margem zero): mensal Essencial R$ 0,0135, Profissional R$ 0,0100, Escala R$ 0,0071; anual Essencial R$ 0,0110, Profissional R$ 0,0081, **Escala R$ 0,0058** (abaixo do R$ 0,006 do pior caso).

**Riscos aceitos pelo dono (registrar em `docs/context.md` na aprovação):**
1. **O Escala é o plano mais apertado** (13,1% no pior caso mensal) e o **Escala anual sem módulos dá prejuízo no pior caso** (-R$ 81,55 por ano), porque o anual recebe 10 meses e entrega 12 meses de cota. Esse ponto **não estava** nas contas que o dono aceitou e precisa de confirmação (D7). O caso esperado continua com 45,8%.
2. **A infra de R$ 3 por empresa é chute** (servidor próprio na Hetzner, sem medição por empresa); no Escala ela pesa R$ 30 por mês.
3. O pior caso exige a cota inteira usada todo mês; o teto de tokens (D2) garante que o custo de IA por resposta não passe de ~R$ 0,006.

## Comportamento esperado

### E1. Catálogo novo e transição (backend)

**Migration aditiva** `backend/prisma/migrations/2026111XXXXXXX_catalog_2026_11/migration.sql` (só `INSERT`; nenhum `UPDATE`, `DELETE`, `DROP` ou mudança de tipo; passa limpa na varredura do `deploy.sh` da 037):

- Três linhas novas em `plans` (ESSENTIAL, PROFESSIONAL, SCALE), com os valores de D1 e D2 e **`version = (SELECT COALESCE(MAX(version), 0) + 1 FROM plans WHERE code = ...)`** calculado na própria instrução (produção tem versões extras do Essencial; nada de número fixo), `active = true`.
- Seis linhas novas em `plan_prices` (mensal e anual de cada plano novo), modo `CUSTOMER_PAYS_META`, `version = 1` (a unicidade é por `plan_id`, e o `plan_id` é novo), **`valid_from = TIMESTAMPTZ '2026-11-01 00:00:00+00'`** (a mesma da semente da 031). Motivo: quem escolhe a versão é o `Plan.version`; um `valid_from` posterior deixaria o código sem preço para relógios anteriores (testes com data fixa, ou um `now` antes do deploy). A data real fica em `created_at`.
- As linhas antigas **não são tocadas** (continuam `active = true`; a leitura já escolhe a maior versão).
- **Compatível com a versão anterior do código:** o código de antes lê a maior versão ativa e passa a vender o catálogo novo, com cotas novas para quem renovar; nada quebra num rollback.

**Cotas novas valem na hora para todos (D4):** uma função pura no domínio, `effectiveQuotas(own, current)`, devolve, para respostas e para tokens, o **maior** valor entre a linha de `Plan` da assinatura e a **versão ativa mais nova do mesmo código**. Ela é aplicada **num ponto só** (o mapeamento `toSubscription` usado pelos três loaders, com um mapa `code -> versão vigente` lido do catálogo), para que IA, gate, `GET /account/billing`, `GET .../entitlements` e os avisos por e-mail vejam o mesmo número. Consequências: quem assina o Essencial antigo passa a 3.000 respostas na janela atual; um pedido criado antes da troca e pago depois (grava a linha antiga) **não** volta às cotas antigas; uma versão futura com cota **menor** não reduz a de quem já assina (só vale quando ele renovar, porque a concessão grava a linha nova). `maxCompanies` **não** entra na regra (não muda neste catálogo; fica para a spec que mudar). O uso já contado na janela permanece.

**Preço novo na próxima renovação (D5):** nenhuma mudança de código. A renovação, o pedido novo e a cotação já leem o catálogo vigente; o período pago não muda de preço e não há reembolso proporcional.

**Teste gratuito em respostas (D8):** variável nova `BILLING_TRIAL_REPLIES` (inteiro de 1 a 1.000, padrão 100). No teste, a cota de respostas é `min(BILLING_TRIAL_REPLIES, cota do plano)`; a de tokens continua `BILLING_TRIAL_TOKENS`, cujo **padrão sobe de 300.000 para 600.000** (100 x 6.000). Motivo: com a cota de tokens fora da tela, o teste de hoje (800 respostas na tela, ~80 na prática pelos tokens) pararia sem explicação.

**Avisos por e-mail de tokens (D3):** `dueNotices` deixa de gerar `QUOTA_TOKENS_80` (o valor do enum fica no banco; nada é apagado). `QUOTA_TOKENS_100` continua, com assunto e texto novos, fixos e **sem a palavra token nem números de tokens**: assunto "As respostas automáticas do Soprei pararam este mês"; corpo dizendo que o limite de uso da inteligência artificial do plano foi atingido antes da cota de respostas, que as mensagens ficam guardadas no painel, a data em que a IA volta (início da próxima janela) e o link `APP_ORIGIN/painel/assinatura`. Os e-mails de respostas (`QUOTA_REPLIES_80` e `_100`) não mudam.

**Aviso de reajuste (D6):** a tarefa periódica dos avisos (E5 da 031) passa a usar o `PRICE_CHANGE`, que já existe no enum. Função pura `renewalPriceIncrease(subscription, catalog)`: verdadeiro se o total da **próxima renovação** (a seleção atual ou a troca agendada, ao preço vigente do catálogo) é **maior** que o total ao preço da assinatura (`sub.price`). Se verdadeiro, não cancelada (`cancelAtPeriodEnd = false`), e o fim do período está entre **30 e 45 dias** à frente, envia **uma vez por período** (chave única `(subscription, PRICE_CHANGE, currentPeriodEnd)`, a mesma trava de inserção da 031) para a conta titular ativa e confirmada. Texto fixo: o novo valor da renovação (do catálogo), a data em que passa a valer (a próxima renovação), que o período pago não muda e que dá para cancelar antes; link para a tela. Hoje só o **anual** pode subir (Escala e módulos), e o primeiro anual pago vence em novembro de 2027, então o aviso sai com folga.

### E2. Tela sem tokens (frontend)

- `SubscriptionPage`: sai a barra "Uso da IA" e o texto "Vale a cota que acabar primeiro"; fica a barra **"Respostas enviadas"** com o texto "Respostas enviadas pelo WhatsApp neste mês". O alerta "Cota do mês esgotada" continua para respostas; quando o motivo é tokens, o texto é **"O limite de uso da inteligência artificial deste mês foi atingido"** (sem número), com a mesma explicação de que nada se perde e a data de volta. O mesmo em `billing-rules.ts` (`accessNotice`) e `AccessNotice.tsx`.
- Cartões de plano: empresas, respostas por mês, preço e, **se D9 for aprovada**, a linha "equivale a R$ 0,016 por resposta" com o valor **vindo do servidor** (campo novo e aditivo `perReplyMilliCents` em cada preço do catálogo de `GET /account/billing`, calculado no servidor como `baseCents x 1000 / (respostas x meses do ciclo)`, arredondado para baixo). O navegador continua sem calcular preço.
- Ciclo anual: o texto "(um pagamento por ano, com desconto)" vira "(um pagamento por ano: 2 meses grátis)". A frase é fixa e o teste da migration garante que anual = 10 x mensal em toda a versão vigente; se um dia não for, a spec que mudar o catálogo muda a frase.
- **A API não muda de forma:** `GET /account/billing` e `GET .../entitlements` continuam devolvendo `tokens` (aditivo, compatível com rollback e com o gate), só a tela deixa de mostrar. Nenhum texto do site contém "token" na área de Assinatura nem nas faixas.

### E3. Política de Privacidade, versão 2 (antes do formulário)

Alteração de `frontend/src/legal/privacidade.md` (`versao: 2`, `atualizado-em:` a data do merge, `situacao: vigente`), sem marcador `[PREENCHER`/`[CONFERIR`. Texto a incluir (redação proposta; o dono pode ajustar):

- **Seção 2**, item novo: "**Interessados**: pessoas que pedem contato comercial pelo formulário do site (por exemplo, sobre o plano Enterprise)."
- **Seção 4**, subseção nova "### Interessados (contato comercial)": "Nome, e-mail, telefone ou WhatsApp (se informado), nome da empresa, quantidade aproximada de empresas ou unidades, volume estimado de mensagens e a mensagem que você escrever. Esses dados **não** ficam no banco de dados do Soprei: são enviados por e-mail para a nossa caixa de contato comercial. O endereço IP é usado por pouco tempo para limitar abusos, como nas outras páginas."
- **Seção 5**, finalidade nova: "Responder pedidos de contato comercial e preparar uma proposta." E, nas bases legais: "Para os dados de interessados, os procedimentos preliminares relacionados a um contrato, a pedido do próprio titular (art. 7º, V, da LGPD)."
- **Seção 7**, linha do Google (Gmail): "enviar códigos, convites e avisos por e-mail **e receber os pedidos de contato comercial**". (Se o dono usar `SALES_CONTACT_EMAIL` em outro provedor, a linha muda junto; passo do dono.)
- **Seção 9**, linha nova da tabela: "Pedidos de contato comercial | guardados na nossa caixa de e-mail por até 12 meses depois do último contato, se não virarem contrato; se virarem, passam a seguir as regras de usuários e de cobrança". Recomendação de prazo: 12 meses (D18).
- Sem e-mail aos usuários: a mudança não altera o tratamento dos dados deles (seção 14 da própria política).

### E4. Plano Enterprise e formulário de contato

**Onde aparece (D10):** (1) na aba **Planos** de `/painel/assinatura`, um quarto cartão, **não selecionável** (não é rádio), "Enterprise — Sob consulta — Para redes, franquias e operações com mais de 10 empresas ou mais de 40 mil respostas por mês" com o botão **"Falar com a gente"**, que abre o formulário num `Modal` (componente existente); aparece também com o checkout desligado; (2) uma página pública **`/fale-conosco`** com o mesmo formulário (componente único `SalesContactForm`), montada pelo `main.tsx` fora do `AccountApp` (sem ler a sessão); (3) o link "Fale com a gente" no menu e no rodapé da página inicial (`App.tsx`). Não se cria página pública de preços (fora de escopo).

**Campos (D17):** Zod `strict`, NFC, sem caractere de controle (exceto quebra de linha na mensagem), sem caracteres invisíveis de formatação (categoria Cf), tamanhos medidos depois da normalização.

| Campo | Regra | Obrigatório |
| --- | --- | :-: |
| `name` | 2 a 100, uma linha | sim |
| `email` | e-mail válido (o mesmo normalizador das contas), até 254 | sim |
| `phone` | 8 a 20 caracteres de dígitos, espaço, `+`, `(`, `)` e `-`, com 8 a 15 dígitos | não |
| `companyName` | 2 a 120, uma linha | sim |
| `units` | enum: `1-10`, `11-30`, `31-100`, `100+` | sim |
| `monthlyVolume` | enum: `ate-40-mil`, `40-a-100-mil`, `100-a-500-mil`, `mais-de-500-mil`, `nao-sei` | sim |
| `message` | 10 a 2.000, até 40 linhas | sim |
| `privacyAck` | literal `true` ("Li a Política de Privacidade", link para `/privacidade`; é ciência, a base legal é o art. 7º, V) | sim |
| `website` | **honeypot**: campo escondido (fora da tela e do leitor de tela, `tabindex="-1"`, `autocomplete="off"`); só aceita vazio | — |
| `formToken` | token do formulário (abaixo) | sim |

**Rotas (D12, D13, D14)** em `presentation/contact/sales-contact.controller.ts`, **só com `ACCOUNTS_ENABLED=true`** (é quando `APP_ORIGIN` e o SMTP existem; sem ele, 404). Públicas: não leem cookie nem token, e a resposta é a mesma logado ou não.

- `GET /contact/sales/form-token` (perfil `public`, `Cache-Control: no-store`): devolve `{ formToken }` = `<emitidoEmMs>.<HMAC-SHA256(chave derivada do JWT_SECRET com o rótulo soprei:sales-contact:v1, "sales-contact:" + emitidoEmMs)>` em base64url. Sem estado.
- `POST /contact/sales` (perfil novo **`contact`**, fail-closed; corpo até 16 KiB; hook de `Origin` igual a `APP_ORIGIN` **e** `X-Soprei-App: web`, como `account.controller.ts`; `no-store`):
  - corpo inválido: **400** com mensagem fixa por campo, **sem ecoar o valor** (não conta como envio);
  - token com HMAC inválido ou mais de 2 h: **400 `FORM_EXPIRED`** ("Recarregue a página e tente de novo");
  - honeypot preenchido, token com menos de 3 s, teto diário estourado ou fila de envio cheia: **202 com a mesma resposta** de sucesso, **nada enviado** (resultado só na métrica);
  - caso normal: **202** `{ message: 'Recebemos o seu contato. Responderemos pelo e-mail informado.' }` antes do envio; o e-mail sai **em segundo plano**, com `drain()` no `closeInfrastructure`; falha de SMTP só em métrica e log (sem dados).
- **Perfil `contact`** (`RATE_LIMIT_CONTACT_MAX`, padrão 5; `RATE_LIMIT_CONTACT_WINDOW_SECONDS`, padrão 3.600), incluído em `FAIL_CLOSED_RATE_LIMIT_PROFILES` (Redis do limiter fora = 503, nada enviado). **Teto global** de 30 e-mails por dia (constante `SALES_CONTACT_DAILY_CAP`; contador `<AUTH_REDIS_PREFIX>sales-contact:day:<AAAA-MM-DD UTC>` com `INCR` e TTL de 48 h; Redis fora = 503 antes de qualquer envio). No máximo 10 envios em andamento.

**E-mail (D11, D15, D16):**

- Destinatário: **`SALES_CONTACT_EMAIL`** (variável nova, opcional, validada como e-mail) e, sem ela, **`EMAIL_PROVIDER_FROM`** (decisão do dono, preservada como padrão). Remetente: o de sempre (`Soprei <EMAIL_PROVIDER_FROM>`).
- **Assunto fixo:** "Novo contato comercial pelo site do Soprei" (nada do formulário no assunto).
- **`Reply-To`:** o e-mail do interessado, como objeto de endereço do `nodemailer` **sem nome de exibição** (o Zod já recusa quebra de linha e espaço; nenhum outro cabeçalho recebe dado do formulário).
- Corpo em texto simples, montado por função pura `salesContactMailText` (`application/contact/`): rótulos fixos e os valores higienizados (campos de uma linha sem quebras; mensagem com `\r\n` -> `\n`, sem controles além de `\n`, sem Cf); faixas de `units` e `monthlyVolume` traduzidas por tabela fixa; linha final "Ciência da Política de Privacidade (versão 2): sim".
- **Nenhuma resposta automática ao interessado** (o formulário não pode virar um jeito de fazer o SMTP do Soprei mandar e-mail a um endereço qualquer).
- **Nada no banco** (D15): o formulário não grava linha nenhuma.

**Privacidade:** nome, e-mail, telefone, empresa, mensagem, token e honeypot **nunca** vão a log, métrica, erro, URL ou storage do navegador. Log só com `requestId` e o resultado; métrica `sales_contact_requests_total{result}` com conjunto fixo: `sent`, `failed`, `spam`, `too_fast`, `capped`, `invalid`, `expired`. O `redact` ganha `formToken`, `phone` e `companyName`. O formulário guarda tudo **só em memória** e limpa ao enviar com sucesso.

### Configuração nova (`.env.example`, validada em `env.schema.ts`)

`BILLING_TRIAL_REPLIES` (1 a 1.000, padrão 100), `BILLING_TRIAL_TOKENS` (padrão passa a 600.000), `SALES_CONTACT_EMAIL` (opcional, e-mail), `RATE_LIMIT_CONTACT_MAX` (padrão 5), `RATE_LIMIT_CONTACT_WINDOW_SECONDS` (padrão 3.600). Todas opcionais: o `config:check` do deploy passa sem mexer no `.env` de produção.

## Etapas (cada uma cabe num PR)

A ordem sugerida pelo pedido foi ajustada: o cartão Enterprise depende do formulário, e o formulário só pode coletar dados com a política nova no ar. Por isso **E3 (política) vem antes de E4 (formulário e cartão)**, ou no mesmo PR.

- **E1, catálogo e transição (backend):** migration, `effectiveQuotas` no mapeamento único, `BILLING_TRIAL_REPLIES`, avisos de tokens (D3), aviso de reajuste (D6), `perReplyMilliCents` no catálogo (se D9), atualização do `AGENTS.md` (seção "Planos e assinaturas").
- **E2, tela sem tokens (frontend):** barras, faixas, cartões, texto do anual, preço por resposta (se D9), e2e.
- **E3, política de privacidade versão 2:** só `privacidade.md` e o teste das páginas legais.
- **E4, formulário de contato e cartão Enterprise:** rotas, perfil `contact`, e-mail, página `/fale-conosco`, `Modal` na Assinatura, links na página inicial, e2e.

## Critérios de aceite

**E1**
- [ ] `catalog-2026-11-migration.integration.test.ts` (schema temporário com rollback, como os testes de migration da 031): depois da migration, `catalog(now)` devolve exatamente os valores de D1 e D2 (centavos e cotas) para os três códigos e os dois ciclos; toda linha antiga de `plans` e `plan_prices` está **idêntica** à de antes (comparação coluna a coluna); nenhuma linha nova tem `SOPREI_PAYS_META`.
- [ ] A mesma migration aplicada sobre um catálogo com versões extras do Essencial (o caso da produção: `Plan` versões 2 e 3, e também `PlanPrice` versões 2 e 3 no plano 1) cria a versão `máx + 1` sem erro de unicidade, e o catálogo passa a ser o novo.
- [ ] Regras do catálogo vigente, em teste: anual = 10 x mensal para base e módulos; preço por resposta estritamente decrescente Essencial > Profissional > Escala no mensal e no anual; tokens por resposta = 6.000 em todo plano (ou o valor de D2).
- [ ] A varredura de migrations do `deploy.sh` (teste existente em `deploy-scripts.test.ts`) não acusa nada no arquivo novo.
- [ ] `effectiveQuotas` (unitário): devolve o maior por campo; com a versão vigente menor que a da assinatura, mantém a da assinatura; com a mesma linha, não muda nada.
- [ ] Integração (Postgres real): assinatura ACTIVE no Essencial versão 1 (800 respostas) vê `replies.limit = 3000` em `GET .../entitlements`, em `GET /account/billing` e no cálculo de `dueNotices`, e a IA só é bloqueada a partir de 3.000 respostas; o `UsageCounter` da janela não muda.
- [ ] Integração: pedido `RENEWAL` criado no catálogo antigo (R$ 59,00) e concedido depois da migration grava a linha antiga de `Plan`, **e a cota continua 3.000**; um pedido criado depois da migration cobra R$ 47,90 (`amountCents = 4790`).
- [ ] Integração: renovação de assinatura mensal do Essencial depois da migration cobra 4.790; a cotação (`GET /account/billing/quote`) mostra 4.790; o período pago em curso não muda.
- [ ] Unitário de `prorateUpgradeCents` com preço antigo na assinatura e preço novo no destino, para toda combinação "up" entre o catálogo antigo e o novo (planos, módulos e os dois ciclos): o valor é positivo e nenhuma combinação cai em `no_increase`.
- [ ] Teste gratuito: assinatura `TRIAL` tem `replies.limit = min(BILLING_TRIAL_REPLIES, 3000)` e `tokens.limit = BILLING_TRIAL_TOKENS`; config recusa `BILLING_TRIAL_REPLIES` fora de 1 a 1.000; padrões 100 e 600.000.
- [ ] `dueNotices` nunca devolve `QUOTA_TOKENS_80`; `QUOTA_TOKENS_100` sai uma vez por janela; o texto e o assunto de `QUOTA_TOKENS_100` não contêm "token" nem dígitos de contagem de tokens (`billing-mail.test.ts`).
- [ ] `renewalPriceIncrease` (unitário): anual Escala antigo -> verdadeiro; anual Essencial antigo -> falso; mensal de todos os planos antigos sem módulos -> falso; mensal com módulos -> falso; troca agendada para plano mais caro -> verdadeiro.
- [ ] `PRICE_CHANGE` (integração com mailer falso e relógio injetado): sai uma vez quando o fim do período está entre 30 e 45 dias e a renovação sobe; não sai a 46 dias, a 29 dias, com `cancelAtPeriodEnd`, para conta não confirmada ou desativada; duas execuções simultâneas enviam um só e-mail; o texto tem o valor do catálogo e nenhum dado de outra conta.
- [ ] Isolamento entre contas (os testes de `billing.integration.test.ts` seguem verdes): a cota efetiva de uma conta nunca depende de uso, plano ou pedido de outra; `effectiveQuotas` só lê o catálogo global.
- [ ] `config.test.ts`: as variáveis novas são opcionais e validadas.

**E2**
- [ ] `billing.test.ts` (frontend, regras puras): a faixa de cota esgotada por tokens usa o texto "O limite de uso da inteligência artificial deste mês foi atingido" e não tem número; por respostas mantém o texto com as respostas.
- [ ] `e2e/billing.spec.ts` (desktop e celular, claro e escuro): a área de Assinatura não contém o texto "token" (busca no texto visível da página, sem diferenciar maiúsculas); só há uma barra de uso (`role="progressbar"`) de respostas; o cartão anual mostra "2 meses grátis"; com D9, o cartão mostra o preço por resposta vindo da fixture da API (a fixture muda o valor e a tela acompanha, provando que não é calculado no navegador).
- [ ] Par de cor novo, se houver, entra em `theme/contrast.test.ts` (mínimo 4,5:1 nos dois temas).

**E3**
- [ ] `legal.test.ts`: `privacidade.md` tem `versao: 2`, `situacao: vigente`, nenhum marcador; o corpo contém "contato comercial", "art. 7º, V" e a linha de prazo da seção 9; a página gerada mostra "Versão 2".

**E4**
- [ ] Sem `ACCOUNTS_ENABLED`, `GET /contact/sales/form-token` e `POST /contact/sales` respondem 404.
- [ ] Inventário de rotas (`rate-limit.test.ts`): as duas rotas declaram perfil (`public` e `contact`); `contact` está em `FAIL_CLOSED_RATE_LIMIT_PROFILES`; nenhuma rota nova é de tenant nem precisa de `subscriptionExempt`.
- [ ] `sales-contact.controller.test.ts` (`fastify.inject`, mailer falso, relógio injetado): sem `Origin` igual a `APP_ORIGIN` ou sem `X-Soprei-App: web` = 403 e nada enviado; corpo com campo a mais = 400; cada limite de tamanho (abaixo e acima) e cada enum inválido = 400 sem o valor na resposta; `privacyAck: false` = 400; token alterado ou com mais de 2 h = 400 `FORM_EXPIRED`; token com menos de 3 s = 202 e nada enviado; honeypot preenchido = 202 idêntico (mesmo corpo e mesmos cabeçalhos) e nada enviado; caso válido = 202 e exatamente um e-mail.
- [ ] O e-mail enviado (mailer falso): destinatário = `SALES_CONTACT_EMAIL` quando definido e `EMAIL_PROVIDER_FROM` quando não; assunto fixo; `replyTo` = endereço do interessado sem nome; nenhum cabeçalho além de `from`, `to`, `replyTo`, `subject`; nome e empresa com `\r\n` injetado chegam numa linha só no corpo; caracteres Cf (por exemplo U+202E) removidos.
- [ ] Teto diário: o 31º pedido válido do dia responde 202 e não envia (`sales_contact_requests_total{result="capped"}`); no dia seguinte (relógio injetado) volta a enviar.
- [ ] Rate limit com Redis real (`*.integration.test.ts`, Redis `/15`, prefixo único): o 6º `POST` do mesmo IP em 1 h recebe 429 com `Retry-After`; com o Redis do limiter fora (`ToggleProxy`), 503 e nada enviado.
- [ ] Falha do SMTP: a resposta continua 202; `result="failed"` na métrica; o log não tem nenhum dado do formulário; o `drain()` espera o envio em andamento no desligamento.
- [ ] **Privacidade com sentinelas** (log capturado em todos os casos acima, inclusive 400, 403, 429, 503 e falha de SMTP): os sentinelas postos em `name`, `email`, `phone`, `companyName`, `message`, `website` e `formToken` não aparecem em log, métrica (`/metrics`) nem corpo de erro.
- [ ] Frontend (unitário e `e2e/sales-contact.spec.ts`, desktop e celular, claro e escuro, 360 px sem rolagem horizontal): o cartão Enterprise aparece na aba Planos (com e sem checkout) e não é selecionável; "Falar com a gente" abre o `Modal` com o foco no primeiro campo e o Esc fecha; `/fale-conosco` funciona sem sessão; a página inicial tem o link; o campo honeypot não é focável nem lido; o link da ciência abre `/privacidade`; depois do envio o formulário é limpo e mostra a mensagem do servidor; erros escolhidos por `status` e `error.code`; nada do formulário em `localStorage`, `sessionStorage`, URL nem título.
- [ ] Pares de cor novos (cartão "Sob consulta", se usar tom próprio) em `contrast.test.ts`.

## Casos de borda e erros

- **Pedido aberto no momento do deploy** (até 24 h de link): se pago depois, cobra o valor antigo (59, 149 ou o anual antigo); a cota fica a nova pela regra do máximo. Risco aceito (D5); o dono pode estornar a diferença a pedido.
- **Renovação antecipada de um anual com aumento** (Escala ou módulos) antes de o aviso de 30 dias sair: a pessoa vê o valor novo na cotação antes de pagar; é escolha dela. Aceito.
- **Assinatura no plano de teste de R$ 1,00 da produção:** a regra do máximo dá as cotas novas do mesmo código; a renovação cobra o catálogo novo.
- **Upgrade criado antes do deploy e pago depois:** concede pela regra de sempre (`upgradeBase` compara código, ciclo, módulos e período); a cota fica a nova.
- **Troca agendada (`pendingChange`)** feita antes: a renovação usa o preço novo do plano pendente (comportamento atual) e o aviso de reajuste considera a troca.
- **Rollback do código depois da migration:** o código anterior vende o catálogo novo e mostra a barra de tokens com os números novos; quem assina o plano antigo volta a ver as cotas antigas até renovar. Sem perda de dado.
- **Cota de tokens estourada com respostas sobrando:** a IA para (como hoje); a faixa e o e-mail explicam sem números; `quota_blocks_total{reason="tokens"}` sobe. Se acontecer com frequência, a razão de D2 está baixa e o dono publica uma versão nova do catálogo.
- **Simulador do painel** gasta tokens e não conta resposta: com 6.000 tokens por resposta incluída, só uso muito intenso do "Testar" chega ao teto.
- **Formulário:** SMTP fora = 202 e o pedido se perde (a pessoa não sabe); mitigação: métrica `failed` para o dono acompanhar. Teto diário estourado por um robô bloqueia pedidos legítimos naquele dia (aceito; métrica `capped`). Pedido legítimo enviado em menos de 3 s é descartado em silêncio (improvável com 6 campos obrigatórios).
- **`Reply-To` com e-mail de terceiro:** quem preenche pode pôr o e-mail de outra pessoa; o dono responderia a ela. O dono lê o pedido antes de responder; sem resposta automática, o Soprei nunca manda nada a esse endereço sozinho.

## Isolamento entre empresas

- **Catálogo** (`Plan`, `PlanPrice`) é global e não tem dado de empresa nem de conta; `effectiveQuotas` só lê o catálogo e a linha de `Plan` já ligada à assinatura. A assinatura, o uso e os pedidos continuam acessados só pelo `AccountId` (cookie) ou pelo `CompanyId` do contexto resolvido no servidor (031). Os testes de isolamento entre contas da 031 continuam obrigatórios e verdes; o critério novo prova que a cota efetiva de uma conta não depende de outra.
- **Formulário de contato:** não lê nem grava dado de empresa, conta ou contato; não recebe `companyId` nem `accountId`; nada vai ao banco.

## Fora de escopo

- **Modo S** (`SOPREI_PAYS_META`): com estas cotas daria prejuízo; segue desligado e, se ligado um dia, terá catálogo próprio em spec própria.
- **Contratação do Enterprise no sistema** (linha de catálogo, preço sob medida, limites próprios, fatura): o Enterprise é só o cartão e o formulário; contrato e provisionamento ficam para uma spec quando houver o primeiro cliente.
- Página pública de preços, comparação de planos na página inicial, CAPTCHA de terceiros, CRM ou tabela de leads, resposta automática ao interessado, anexos no formulário.
- Pacote extra de respostas (E6 da 031); ajustar `TOKENS_PER_EXTRA_REPLY` (8.000) à razão nova fica para quando o pacote existir.
- Reembolso proporcional, estorno automático, migração de quem pagou o anual antigo para o preço novo antes do fim do período.
- Mudar `maxCompanies` de quem já assina; aviso de reajuste quando o aumento for publicado a menos de 30 dias de uma renovação (não acontece nesta troca; a próxima spec que subir preço trata).
- Medição real do custo de infraestrutura por empresa.

## Decisões (o dono decide; recomendação primeiro)

- **D1 (DECIDIDA pelo dono, 2026-11-13) Catálogo e preços.** Os valores da tabela "O catálogo novo", anual = 10 x mensal, módulos com o mesmo preço mensal, margem do pior caso aceita. *A confirmar:* o efeito no anual (Escala e módulos sobem 4,2%; ver D6 e D7).
- **D2 Cota de tokens (proteção, fora da tela).** *Recomendação:* **6.000 tokens por resposta incluída: 18 M, 60 M e 240 M.** Justificativa: (a) é o maior teto que mantém o custo de IA no pior caso em ~R$ 0,006 por resposta, mesmo com a mistura mais cara que os limites permitem (saída máxima de 1.024 tokens por chamada e até 4 chamadas por turno: ~R$ 0,001 por mil tokens), então a tabela de margem continua valendo; (b) dá 60% de folga sobre os ~3.700 tokens típicos, de modo que a cota **escondida** quase nunca estoura antes da cota **visível** (turnos com ferramentas da agenda e o "Testar" gastam mais); (c) no teste gratuito, 100 respostas x 6.000 = 600 mil tokens. *Alternativas:* **4.000 por resposta (12 M, 40 M, 160 M, sugestão do dono)**: custo máximo menor (~R$ 0,004), mas só 8% acima do típico, e a IA pararia por um limite que o cliente não vê sempre que usar a agenda com ferramentas ou testar muito; **8.000 (24 M, 80 M, 320 M)**: igual ao `TOKENS_PER_EXTRA_REPLY`, mas com a mistura cara passa de R$ 0,006 por resposta.
- **D3 Aviso de tokens.** *Recomendação:* o e-mail de **80%** sai (vira só sinal interno: métrica `quota_blocks_total{reason="tokens"}` e o log de bloqueio, que já existem; o dono acompanha e corrige a razão de D2 por versão de catálogo); o de **100%** continua, sem a palavra token (a IA parou e a pessoa precisa saber por quê); a faixa no painel continua, sem número. *Alternativa:* nenhum e-mail de tokens (a IA pararia e a pessoa só descobriria pelo painel).
- **D4 Cotas novas para quem já assina.** *Recomendação:* **na hora, para todos**, pela regra do máximo no código (`effectiveQuotas`): sem `UPDATE` na migration, cobre pedidos antigos pagos depois e o teste gratuito, e uma redução futura nunca atinge o período pago. *Alternativa:* `UPDATE subscriptions SET plan_id = <linha nova do mesmo código>` na migration (menos código, mas é escrita em linha existente, não cobre o pedido antigo pago depois e deixa `price_id` apontando para um preço de outra linha de `Plan`).
- **D5 Preço novo para quem já assina.** *Recomendação:* **a partir da próxima renovação**, sem reembolso proporcional (já é o comportamento do código); link aberto no deploy cobra o valor antigo (risco aceito). *Alternativa:* expirar os pedidos abertos na migration (é `UPDATE` de pedidos e não impede pagar o link, que vale na InfinitePay).
- **D6 Anual pago a 12 x 0,8 em curso e o reajuste.** *Recomendação:* o período pago fica como está, **ganha as cotas mensais novas já** (D4) e renova ao preço novo; como o Escala anual e os módulos anuais **sobem**, os termos (seção 7) exigem aviso por e-mail com 30 dias: o **aviso automático `PRICE_CHANGE`** entre 45 e 30 dias antes da renovação (usa o enum, a trava e a tarefa da 031). *Alternativas:* e-mail manual do dono a cada assinante anual afetado (provavelmente zero ou poucos hoje, mas depende de lembrar daqui a um ano); ou manter o anual de Escala e dos módulos em 9,6 x (contraria D1).
- **D7 Escala anual com prejuízo no pior caso (-R$ 81,55 por ano, -2,3%).** *Recomendação:* **manter 10 x (D1)** e registrar como risco aceito, porque o pior caso exige 40 mil respostas todo mês por 12 meses e o esperado tem 45,8%; o dono revê se um Escala anual passar de 85% da cota de respostas por dois meses seguidos. *Alternativas:* Escala anual a 11 x (R$ 3.839,00; pior caso +R$ 234,30, 6,1%); ou Escala anual sem desconto.
- **D8 Teste gratuito.** *Recomendação:* **100 respostas** (`BILLING_TRIAL_REPLIES`) e **600 mil tokens** (padrão de `BILLING_TRIAL_TOKENS`); custo de IA do teste no pior caso ~R$ 0,60. *Alternativa:* 50 respostas e 300 mil tokens (mantém o padrão atual da variável).
- **D9 Preço por resposta na tela.** *Recomendação:* **mostrar** "equivale a R$ 0,016 por resposta" em cada cartão, com o valor calculado no servidor (deixa o "efeito batata" visível para quem compra). *Alternativa:* só na spec e no material de venda.
- **D10 Onde o Enterprise aparece.** *Recomendação:* cartão na aba Planos da Assinatura, página pública `/fale-conosco` e link "Fale com a gente" na página inicial; **sem** página pública de preços nesta spec. *Alternativa:* só na Assinatura (quem ainda não tem conta não acha o contato).
- **D11 Destinatário do e-mail.** O dono decidiu o remetente do SMTP. *Recomendação:* manter isso como **padrão** e acrescentar `SALES_CONTACT_EMAIL` **opcional**, porque o remetente costuma ser uma caixa `noreply` (é o exemplo do `.env.example`) que ninguém lê; `EMAIL_PROVIDER_FROM` já é só o endereço, sem nome a extrair. *Alternativa:* só `EMAIL_PROVIDER_FROM`, sem variável nova.
- **D12 Rota pública ou autenticada.** *Recomendação:* **uma rota pública só**, que não lê o cookie: o mesmo formulário serve ao painel e ao site, com as mesmas proteções, e o pedido não fica ligado à conta (minimização). *Alternativa:* duas rotas (uma com cookie, preenchendo o e-mail da conta): mais código e mais dado.
- **D13 Rate limit.** *Recomendação:* perfil novo **`contact`**, fail-closed, 5 por hora por IP, mais o teto global silencioso de 30 por dia. O `login` não serve: o contador por IP é compartilhado com cadastro e entrada, então quem pede contato perderia tentativas de login (e vice-versa). *Alternativa:* reaproveitar `login`.
- **D14 Antispam sem CAPTCHA.** *Recomendação:* **honeypot + token de formulário assinado** (tempo mínimo de 3 s, validade de 2 h, sem estado) + perfil `contact` + teto diário. *Alternativa:* só honeypot e teto (sem a rota `GET`, mas sem tempo mínimo confiável: o tempo vindo do navegador é forjável).
- **D15 Banco.** *Recomendação:* **nada no banco**, só o e-mail (menos dado guardado e nenhuma tabela nova para a política de retenção). *Alternativa:* tabela de leads (exigiria expurgo, tela e base para a 032).
- **D16 `Reply-To` e resposta automática.** *Recomendação:* `Reply-To` com o e-mail do interessado (o dono responde direto), sem nome de exibição; **sem** confirmação automática ao interessado. *Alternativa:* sem `Reply-To` (o dono copia o endereço do corpo).
- **D17 Campos.** *Recomendação:* os da tabela, com **telefone opcional** (minimização: o e-mail basta para responder) e faixas em vez de números livres para unidades e volume (validação simples, menos texto livre). *Alternativa:* telefone obrigatório.
- **D18 Prazo de guarda na política.** *Recomendação:* **12 meses** depois do último contato, se não virar contrato. *Alternativa:* 6 meses.

## Dependências novas

Nenhuma. `nodemailer`, Zod, Redis, `node:crypto` e o `Modal` já existem. Migration aditiva só com `INSERT`. Variáveis novas, todas opcionais, listadas em "Configuração nova". Um perfil de rate limit novo (`contact`).

## Passos do dono

1. Responder D2 a D18 (e confirmar D1 diante do efeito no anual e de D7); registrar as decisões em `docs/context.md`.
2. Antes do E1 em produção: **conferir no banco do servidor** se há pedidos `PENDING` abertos (serão cobrados pelo valor antigo se pagos) e quantas assinaturas `ANNUAL` existem com Escala ou módulos (receberão o aviso de reajuste perto do fim do período).
3. Depois do merge de cada etapa, o deploy automático aplica a migration (aditiva). Nenhuma variável é obrigatória; se quiser outra caixa para os pedidos comerciais, `SALES_CONTACT_EMAIL` no `backend/.env` e reiniciar.
4. E3 antes ou junto do E4: revisar a redação da política (versão 2) e, se `SALES_CONTACT_EMAIL` apontar para outro provedor que não o Gmail, ajustar a linha do fornecedor na seção 7.
5. Depois do E4: enviar um pedido de teste em `/fale-conosco` e conferir o e-mail (assunto, `Reply-To`, texto); acompanhar `sales_contact_requests_total` e `quota_blocks_total{reason="tokens"}` nas primeiras semanas.
6. Material de venda e termos: a seção 7 dos termos já cobre o reajuste com aviso; nenhuma mudança nos termos é exigida por esta spec.

## Registro da implementação

(vazio)
