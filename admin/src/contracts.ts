import { z } from 'zod';

/**
 * Contratos das rotas `/platform/*` que o admin lê (spec 044). Todo o formato esperado do servidor fica
 * neste arquivo: ajustar o app ao formato real da E2 é mexer aqui (e nas fixturas do Playwright, que são
 * validadas por estes mesmos esquemas).
 *
 * As rotas de entrada (`/platform/auth/*`) são as da E1, conferidas no código. As de leitura e as ações
 * (E2) foram escritas a partir da lista de campos da spec, em paralelo com o backend. Onde a spec não diz
 * o formato, a escolha foi (registrada também no Registro da implementação da spec):
 *
 * 1. **Agrupamentos** (empresas por estado, assinaturas por plano, conexões por modo, handoffs por motivo,
 *    fila por estado, contadores) são listas `{ key, count }`, não objetos de chaves fixas: um valor novo
 *    no servidor aparece na tela sem quebrar a leitura.
 * 2. **Listas paginadas:** `{ items, nextCursor }` (`nextCursor` nulo no fim).
 * 3. **Cobrança desligada:** `billingEnabled: false` no `overview` e no detalhe da empresa (com
 *    `subscription` e `paidThisMonth` nulos); nas listas de pedidos e avisos, `items: null`.
 * 4. **"Precisa de atenção" levando à lista filtrada:** `GET /platform/companies` aceita também
 *    `attention=pending_messages|unsent_replies|token_invalid|token_expiring|open_handoffs` (proposta do E3
 *    para a E2; a tela Canal é essa lista com `token_invalid` e `token_expiring`).
 * 5. **Saúde:** fila, retomada e limpeza são uniões discriminadas por `status`
 *    (`ok`/`unavailable`/`disabled` e `ran`/`never`/`disabled`); contadores são `{ name, label, value }`
 *    (`label` é o valor do único rótulo da métrica, como o `result`, ou nulo).
 * 6. **Datas:** texto ISO 8601 em UTC (`toISOString()` do servidor); ids: UUID.
 *
 * Os objetos não são `strict` (campo a mais do servidor é ignorado, nunca mostrado); campo que falta ou
 * com tipo errado faz a tela mostrar "resposta inesperada", nunca o texto do servidor.
 */

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const cents = z.number().int();
const shortText = z.string().max(200);
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const cursor = z.string().min(1).max(512).nullable();

/** Agrupamento genérico: `{ key, count }` (ver item 1 do topo). */
export const groupSchema = z.array(z.object({ key: code, count })).max(100);
export type Group = z.infer<typeof groupSchema>;

export const companyStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export const accessStatusSchema = z.enum(['ACTIVE', 'DISABLED']);
export const planSchema = z.enum(['ESSENTIAL', 'PROFESSIONAL', 'SCALE']);
export const cycleSchema = z.enum(['MONTHLY', 'ANNUAL']);
export const subscriptionStateSchema = z.enum([
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
]);
export const accessLevelSchema = z.enum(['ok', 'grace', 'blocked']);
export const channelStateSchema = z.enum(['NOT_CONNECTED', 'CONNECTED', 'TOKEN_INVALID']);
export const channelModeSchema = z.enum(['API_ONLY', 'COEXISTENCE']);
export const membershipRoleSchema = z.enum(['OWNER', 'ADMIN', 'AGENT', 'VIEWER']);

/** Motivos aceitos por suspender e reativar (D1), na ordem em que a tela os oferece. */
export const ACTION_REASONS = ['PAYMENT', 'ABUSE', 'OWNER_REQUEST', 'OTHER'] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

/** Filtros de "precisa de atenção" da lista de empresas (ver item 4 do topo). */
export const ATTENTION_FILTERS = [
  'pending_messages',
  'unsent_replies',
  'token_invalid',
  'token_expiring',
  'open_handoffs',
] as const;
export type AttentionFilter = (typeof ATTENTION_FILTERS)[number];

// --- E1: entrada ---------------------------------------------------------------------------------

/** `GET /platform/auth/session`. */
export const sessionSchema = z.object({ email: z.string().max(320) });
export type Session = z.infer<typeof sessionSchema>;

// --- E2: visão geral -----------------------------------------------------------------------------

const trafficSchema = z.object({ contactMessages: count, replies: count, fallbacks: count });

/** `GET /platform/overview`. */
export const overviewSchema = z.object({
  billingEnabled: z.boolean(),
  companies: groupSchema,
  accounts: z.object({ total: count, verified: count, unverified: count, disabled: count }),
  subscriptions: z.object({ byState: groupSchema, byPlan: groupSchema }).nullable(),
  channel: z.object({ byState: groupSchema, byMode: groupSchema }),
  traffic: z.object({ last24h: trafficSchema, last7d: trafficSchema }),
  attention: z.object({
    pendingMessages: count,
    unsentReplies: count,
    tokenInvalid: count,
    tokenExpiring: count,
    openHandoffs: count,
  }),
  paidThisMonth: z.object({ count, amountCents: cents }).nullable(),
});
export type Overview = z.infer<typeof overviewSchema>;

// --- E2: empresas --------------------------------------------------------------------------------

export const companyListItemSchema = z.object({
  id,
  name: shortText,
  slug: shortText,
  status: companyStatusSchema,
  createdAt: instant,
  lastActivityAt: instant.nullable(),
  plan: planSchema.nullable(),
  access: accessLevelSchema.nullable(),
  channelState: channelStateSchema,
  activeMembers: count,
  messages7d: count,
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;

/** `GET /platform/companies?status=&q=&attention=&cursor=&limit=`. */
export const companyPageSchema = z.object({
  items: z.array(companyListItemSchema).max(50),
  nextCursor: cursor,
});
export type CompanyPage = z.infer<typeof companyPageSchema>;

const windowSchema = z.object({
  activeConversations: count,
  contactMessages: count,
  replies: count,
  fallbacks: count,
  uncertainDeliveries: count,
  handoffs: groupSchema,
});

/** `GET /platform/companies/:companyId`. */
export const companyDetailSchema = z.object({
  id,
  name: shortText,
  slug: shortText,
  status: companyStatusSchema,
  createdAt: instant,
  lastActivityAt: instant.nullable(),
  hasPersona: z.boolean(),
  modules: z.array(code).max(20),
  onboarding: z.array(z.object({ key: code, done: z.boolean() })).max(20),
  members: z.array(z.object({ role: membershipRoleSchema, status: accessStatusSchema, count })),
  owner: z
    .object({
      accountId: id,
      emailVerified: z.boolean(),
      status: accessStatusSchema,
      createdAt: instant,
    })
    .nullable(),
  billingEnabled: z.boolean(),
  subscription: z
    .object({
      plan: planSchema,
      cycle: cycleSchema,
      modules: z.array(code).max(20),
      state: subscriptionStateSchema,
      access: accessLevelSchema,
      periodStart: instant,
      periodEnd: instant,
      cancelAtPeriodEnd: z.boolean(),
      scheduledChange: z
        .object({ plan: planSchema, cycle: cycleSchema, effectiveAt: instant })
        .nullable(),
      usage: z.object({
        windowStart: instant,
        windowEnd: instant,
        replies: count,
        repliesQuota: count.nullable(),
        tokens: count,
        tokensQuota: count.nullable(),
      }),
    })
    .nullable(),
  channel: z
    .object({
      state: channelStateSchema,
      mode: channelModeSchema,
      phoneNumberId: z.string().max(64).nullable(),
      wabaId: z.string().max(64).nullable(),
      connectedAt: instant.nullable(),
      tokenExpiresAt: instant.nullable(),
      tokenInvalidAt: instant.nullable(),
    })
    .nullable(),
  attendance: z.object({ last24h: windowSchema, last7d: windowSchema, last30d: windowSchema }),
  attention: z.object({
    pendingMessages: count,
    unsentReplies: count,
    tokenInvalid: z.boolean(),
    tokenExpiring: z.boolean(),
    openHandoffs: count,
  }),
  content: z.object({ documents: count, activeProducts: count, upcomingBookings7d: count }),
});
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

// --- E2: contas ----------------------------------------------------------------------------------

export const accountListItemSchema = z.object({
  id,
  emailMasked: z.string().max(320),
  status: accessStatusSchema,
  verified: z.boolean(),
  createdAt: instant,
  companies: count,
  hasSubscription: z.boolean(),
});
export type AccountListItem = z.infer<typeof accountListItemSchema>;

/** `GET /platform/accounts?status=&verified=&cursor=`. */
export const accountPageSchema = z.object({
  items: z.array(accountListItemSchema).max(50),
  nextCursor: cursor,
});
export type AccountPage = z.infer<typeof accountPageSchema>;

/** `GET /platform/accounts/:accountId` (com o e-mail completo: cada leitura é auditada, D7). */
export const accountDetailSchema = z.object({
  id,
  email: z.string().max(320),
  status: accessStatusSchema,
  verified: z.boolean(),
  createdAt: instant,
  companies: z
    .array(z.object({ id, name: shortText, slug: shortText, role: membershipRoleSchema }))
    .max(100),
  subscription: z
    .object({
      plan: planSchema,
      cycle: cycleSchema,
      state: subscriptionStateSchema,
      access: accessLevelSchema,
      periodEnd: instant,
    })
    .nullable(),
});
export type AccountDetail = z.infer<typeof accountDetailSchema>;

// --- E2: cobrança --------------------------------------------------------------------------------

export const orderSchema = z.object({
  id,
  kind: z.enum(['NEW', 'RENEWAL', 'UPGRADE', 'EXTRA_PACK']),
  status: z.enum(['PENDING', 'PAID', 'EXPIRED', 'FAILED']),
  amountCents: cents,
  captureMethod: z.string().max(32).nullable(),
  createdAt: instant,
  paidAt: instant.nullable(),
  expiresAt: instant.nullable(),
  periodStart: instant.nullable(),
  periodEnd: instant.nullable(),
  accountId: id,
});
export type Order = z.infer<typeof orderSchema>;

/** `GET /platform/billing/orders?status=&kind=&cursor=` (`items: null` com a cobrança desligada). */
export const orderPageSchema = z.object({
  items: z.array(orderSchema).max(50).nullable(),
  nextCursor: cursor,
});
export type OrderPage = z.infer<typeof orderPageSchema>;

export const noticeSchema = z.object({
  kind: code,
  windowStart: instant.nullable(),
  createdAt: instant,
  accountId: id,
});
export type Notice = z.infer<typeof noticeSchema>;

/** `GET /platform/billing/notices?kind=&cursor=` (`items: null` com a cobrança desligada). */
export const noticePageSchema = z.object({
  items: z.array(noticeSchema).max(50).nullable(),
  nextCursor: cursor,
});
export type NoticePage = z.infer<typeof noticePageSchema>;

// --- E2: saúde -----------------------------------------------------------------------------------

const jobSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ran'),
    at: instant,
    result: z.enum(['ok', 'error']),
    counts: groupSchema,
  }),
  z.object({ status: z.literal('never') }),
  z.object({ status: z.literal('disabled') }),
]);
export type JobRun = z.infer<typeof jobSchema>;

/** `GET /platform/health`. */
export const healthSchema = z.object({
  checkedAt: instant,
  bootedAt: instant,
  database: z.enum(['up', 'down']),
  redis: z.enum(['up', 'down']),
  queue: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), counts: groupSchema }),
    z.object({ status: z.literal('unavailable') }),
    z.object({ status: z.literal('disabled') }),
  ]),
  resume: jobSchema,
  cleanup: jobSchema,
  counters: z
    .array(z.object({ name: code, label: code.nullable(), value: z.number().nonnegative() }))
    .max(100),
});
export type Health = z.infer<typeof healthSchema>;

// --- Corpo das ações -----------------------------------------------------------------------------

/** Corpo de `POST /platform/companies/:companyId/suspend` e `.../reactivate` (204). */
export const actionBodySchema = z.object({ reason: z.enum(ACTION_REASONS) }).strict();
