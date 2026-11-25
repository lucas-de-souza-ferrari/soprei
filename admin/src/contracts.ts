import { z } from 'zod';

/**
 * Contratos das rotas `/platform/*` que o admin lê (spec 044). Todo o formato esperado do servidor fica
 * neste arquivo (e nas fixturas do Playwright, que são validadas por estes mesmos esquemas).
 *
 * As rotas de entrada (`/platform/auth/*`) são as da E1. As de leitura e as ações seguem os tipos de
 * resposta exportados pela E2 em `backend/src/presentation/platform/platform-monitor.controller.ts`
 * (`PlatformOverviewResponse`, `PlatformCompanyListResponse`, `PlatformCompanyDetailResponse`,
 * `PlatformAccountListResponse`, `PlatformAccountDetailResponse`, `PlatformOrderListResponse`,
 * `PlatformNoticeListResponse`, `PlatformHealthResponse`) e os filtros de
 * `platform-monitor.validators.ts`. Pontos do formato:
 *
 * 1. **Agrupamentos** (assinaturas por estado, plano e acesso; canal por estado e modo; handoffs por
 *    motivo; resultados do contato comercial) são objetos com **chaves fixas** (`{ ACTIVE: n, ... }`),
 *    todas presentes, mesmo com zero. A fila (`queue.jobs`) é o único mapa livre (estado do BullMQ).
 * 2. **Listas paginadas:** `{ items, nextCursor }` (`nextCursor` nulo no fim).
 * 3. **Cobrança desligada:** `billingEnabled: false` no `overview` (com `subscriptions` e
 *    `paidOrdersThisMonth` nulos), nos detalhes (`subscription` e `usage` nulos) e nas listas de pedidos
 *    e avisos (com `items: []`).
 * 4. **Filtros das consultas em minúsculas** (`status=active`, `kind=extra_pack`, `verified=true`); os
 *    enums das respostas vêm em maiúsculas. Valor desconhecido na consulta é 400: o app só manda os
 *    valores das listas abaixo.
 * 5. **Saúde:** fila e retomada são uniões discriminadas por `state` (`ok`/`unavailable`/`disabled` e
 *    `ran`/`not_run`/`disabled`; a limpeza da fila vem dentro da execução da retomada); os contadores são
 *    um objeto de chaves fixas.
 * 6. **Datas:** texto ISO 8601 em UTC (`toISOString()` do servidor); ids: UUID.
 * 7. **E-mail (spec 045, D3):** listas, pessoas da empresa e detalhe da conta trazem só `emailMasked`; o
 *    completo vem só de `GET /platform/accounts/:accountId/email` (`PlatformAccountEmailResponse`), que o
 *    servidor audita.
 *
 * Os objetos não são `strict` (campo a mais do servidor é ignorado, nunca mostrado); campo que falta ou
 * com tipo errado faz a tela mostrar "resposta inesperada", nunca o texto do servidor.
 */

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const cents = z.number().int();
const shortText = z.string().max(200);
const cursor = z.string().min(1).max(512).nullable();
/**
 * E-mail mascarado no banco (`l***@exemplo.com`: primeira letra e domínio). O formato é conferido aqui
 * também: um e-mail inteiro no lugar do mascarado é "resposta inesperada", nunca aparece na tela.
 */
const maskedEmail = z
  .string()
  .max(320)
  .regex(/^[^@]\*\*\*@[^@]*$/);

/**
 * Dono ativo (spec 045, E1), calculado só no servidor: vínculo `OWNER` ativo com a conta ativa (ou sem
 * conta). `accountId` nulo: vínculo antigo da CLI.
 */
const ownerSchema = z.object({ accountId: id.nullable(), emailMasked: maskedEmail });

/** Objeto com um valor para cada chave da lista (todas presentes; chave a mais é descartada). */
function fixedKeys<const K extends readonly [string, ...string[]], V extends z.ZodType>(
  keys: K,
  value: V,
) {
  return z.object(Object.fromEntries(keys.map((key) => [key, value])) as { [P in K[number]]: V });
}

/** Pares `[chave, contagem]` na ordem da lista (a ordem em que a tela mostra). */
export function countEntries<K extends string>(
  keys: readonly K[],
  counts: Readonly<Record<K, number>>,
): (readonly [K, number])[] {
  return keys.map((key) => [key, counts[key]] as const);
}

export const COMPANY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export const ACCESS_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export const PLAN_CODES = ['ESSENTIAL', 'PROFESSIONAL', 'SCALE'] as const;
export const BILLING_CYCLES = ['MONTHLY', 'ANNUAL'] as const;
export const SUBSCRIPTION_STATES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'] as const;
export const ACCESS_LEVELS = ['ok', 'grace', 'blocked'] as const;
export const CHANNEL_STATES = ['CONNECTED', 'TOKEN_INVALID', 'NOT_CONNECTED', 'LEGACY'] as const;
export const CHANNEL_MODES = ['API_ONLY', 'COEXISTENCE'] as const;
export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const;
export const HANDOFF_REASONS = [
  'CONTACT_REQUESTED',
  'CANNOT_HELP',
  'COMPLAINT',
  'SENSITIVE',
  'OTHER',
] as const;
export const ORDER_KINDS = ['NEW', 'RENEWAL', 'UPGRADE', 'EXTRA_PACK'] as const;
export const ORDER_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'] as const;
export const NOTICE_KINDS = [
  'QUOTA_REPLIES_80',
  'QUOTA_REPLIES_100',
  'QUOTA_TOKENS_80',
  'QUOTA_TOKENS_100',
  'PERIOD_ENDING_7D',
  'PERIOD_ENDING_1D',
  'PERIOD_ENDED',
  'PRICE_CHANGE',
  'PERIOD_GRACE_ENDED',
  'PAYMENT_RECEIVED',
  'PLAN_CHANGE_APPLIED',
  'DOWNGRADE_BLOCKED',
  'TRIAL_ENDING',
  'TRIAL_ENDED',
] as const;
/** Resultados do contato comercial (spec 040), na ordem da Saúde. */
export const SALES_CONTACT_RESULTS = [
  'sent',
  'failed',
  'spam',
  'too_fast',
  'capped',
  'daily_cap',
  'invalid',
  'expired',
] as const;
/** Estados da fila que o backend lê do BullMQ, na ordem da tela (outro estado aparece depois). */
export const QUEUE_JOB_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;

export const companyStatusSchema = z.enum(COMPANY_STATUSES);
export const accessStatusSchema = z.enum(ACCESS_STATUSES);
export const planSchema = z.enum(PLAN_CODES);
export const cycleSchema = z.enum(BILLING_CYCLES);
export const subscriptionStateSchema = z.enum(SUBSCRIPTION_STATES);
export const accessLevelSchema = z.enum(ACCESS_LEVELS);
export const channelStateSchema = z.enum(CHANNEL_STATES);
export const channelModeSchema = z.enum(CHANNEL_MODES);
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);

/** Motivos aceitos por suspender e reativar (D1), na ordem em que a tela os oferece. */
export const ACTION_REASONS = ['PAYMENT', 'ABUSE', 'OWNER_REQUEST', 'OTHER'] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

/** Filtro `attention` de `GET /platform/companies` (o mesmo critério de cada item do overview). */
export const ATTENTION_FILTERS = [
  'pending_messages',
  'unsent_replies',
  'token_invalid',
  'token_expiring',
  'open_handoffs',
] as const;
export type AttentionFilter = (typeof ATTENTION_FILTERS)[number];

/** Valores aceitos nos filtros das listas (minúsculos; ver item 4 do topo). */
export type CompanyStatusFilter = 'active' | 'suspended';
export type AccountStatusFilter = 'active' | 'disabled';
export type VerifiedFilter = 'true' | 'false';
/** `status` de `GET /platform/billing/orders`, par a par com `ORDER_STATUSES`. */
export const ORDER_STATUS_FILTERS = ['pending', 'paid', 'expired', 'failed'] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];
/** `kind` de `GET /platform/billing/orders`, par a par com `ORDER_KINDS`. */
export const ORDER_KIND_FILTERS = ['new', 'renewal', 'upgrade', 'extra_pack'] as const;
export type OrderKindFilter = (typeof ORDER_KIND_FILTERS)[number];

// --- E1: entrada ---------------------------------------------------------------------------------

/** `GET /platform/auth/session`. */
export const sessionSchema = z.object({ email: z.string().max(320) });
export type Session = z.infer<typeof sessionSchema>;

// --- E2: visão geral -----------------------------------------------------------------------------

const volumeSchema = z.object({ contactMessages: count, replies: count, fallbackReplies: count });

/** `GET /platform/overview` (`PlatformOverviewResponse`). */
export const overviewSchema = z.object({
  generatedAt: instant,
  billingEnabled: z.boolean(),
  companies: z.object({ active: count, suspended: count }),
  accounts: z.object({ total: count, verified: count, unverified: count, disabled: count }),
  subscriptions: z
    .object({
      byState: fixedKeys(SUBSCRIPTION_STATES, count),
      byPlan: fixedKeys(PLAN_CODES, count),
      byAccess: fixedKeys(ACCESS_LEVELS, count),
    })
    .nullable(),
  channel: z.object({
    byState: fixedKeys(CHANNEL_STATES, count),
    byMode: fixedKeys(CHANNEL_MODES, count),
  }),
  attendance: z.object({ last24h: volumeSchema, last7d: volumeSchema }),
  attention: z.object({
    stalledPending: count,
    unsentReplies: count,
    tokenInvalid: count,
    tokensExpiringSoon: count,
    openHandoffs: count,
  }),
  paidOrdersThisMonth: z.object({ monthStart: instant, count, amountCents: cents }).nullable(),
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
  /** O dono ativo mais antigo (spec 045, E1); `null` sem dono ativo. `accountId` nulo: vínculo da CLI. */
  owner: ownerSchema.nullable(),
  /** Quantos donos ativos (vínculo e conta ativos); `0` = "Sem dono ativo". */
  owners: count,
  /** Spec 045, E3a: quando foi removida (só no filtro `status=removed`); `null` nas outras. */
  removedAt: instant.nullable(),
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;

/** `GET /platform/companies?status=&q=&attention=&cursor=&limit=` (`PlatformCompanyListResponse`). */
export const companyPageSchema = z.object({
  items: z.array(companyListItemSchema).max(50),
  nextCursor: cursor,
});
export type CompanyPage = z.infer<typeof companyPageSchema>;

const modulesSchema = z.object({ schedule: z.boolean(), inventory: z.boolean() });

/** A assinatura como a E2 a mostra (no detalhe da empresa e no da conta). */
export const subscriptionSchema = z.object({
  id,
  plan: z.object({ code: planSchema, name: shortText }),
  cycle: cycleSchema,
  modules: modulesSchema,
  /** Estado gravado. */
  status: subscriptionStateSchema,
  /** Estado efetivo agora. */
  state: subscriptionStateSchema,
  access: accessLevelSchema,
  currentPeriodStart: instant,
  currentPeriodEnd: instant,
  trialEndsAt: instant.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** Troca agendada para a próxima renovação. */
  pendingChange: z
    .object({ planCode: planSchema, cycle: cycleSchema, agenda: z.boolean(), stock: z.boolean() })
    .nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

const windowSchema = z.object({
  activeConversations: count,
  contactMessages: count,
  replies: count,
  fallbacks: count,
  uncertainDeliveries: count,
  handoffs: fixedKeys(HANDOFF_REASONS, count),
});

const quotaSchema = z.object({ used: count, limit: count });

/** Uma pessoa (vínculo) no detalhe da empresa (spec 045, E1). */
export const personSchema = z.object({
  membershipId: id,
  /** `null`: vínculo antigo da CLI, sem conta (sem "Abrir conta"). */
  accountId: id.nullable(),
  emailMasked: maskedEmail,
  role: membershipRoleSchema,
  status: accessStatusSchema,
  createdAt: instant,
  account: z.object({ status: accessStatusSchema, verified: z.boolean() }).nullable(),
});
export type Person = z.infer<typeof personSchema>;

/** `GET /platform/companies/:companyId` (`PlatformCompanyDetailResponse`). */
export const companyDetailSchema = z.object({
  billingEnabled: z.boolean(),
  id,
  name: shortText,
  slug: shortText,
  status: companyStatusSchema,
  createdAt: instant,
  updatedAt: instant,
  /** Spec 045, E3a: o detalhe também responde para a removida (para restaurar). */
  removedAt: instant.nullable(),
  hasPersona: z.boolean(),
  onboarding: z.object({
    dismissed: z.boolean(),
    steps: z.object({
      persona: z.boolean(),
      knowledge: z.boolean(),
      schedule: z.boolean(),
      inventory: z.boolean(),
    }),
  }),
  /** Módulos liberados agora (cobrança desligada: tudo; sem assinatura: nada). */
  modules: modulesSchema,
  memberships: z
    .array(z.object({ role: membershipRoleSchema, status: accessStatusSchema, count }))
    .max(20),
  /** Pessoas da empresa (spec 045, E1): até 50, dono primeiro, e-mail mascarado. */
  people: z.array(personSchema).max(50),
  /** Todas as pessoas (vínculos) da empresa, além das 50 listadas. */
  peopleTotal: count,
  /** O dono ativo mais antigo, calculado no servidor (o app só exibe); `null` sem dono ativo. */
  owner: ownerSchema.nullable(),
  /** Donos ativos; `0` = aviso "Empresa sem dono ativo". */
  owners: count,
  pendingInvitations: count,
  /** Titular da ASSINATURA (quem paga), sem e-mail; não é o dono da empresa. */
  holder: z
    .object({
      accountId: id,
      emailVerified: z.boolean(),
      status: accessStatusSchema,
      createdAt: instant,
    })
    .nullable(),
  subscription: subscriptionSchema.nullable(),
  usage: z
    .object({ windowStart: instant, windowEnd: instant, replies: quotaSchema, tokens: quotaSchema })
    .nullable(),
  channel: z.object({
    state: channelStateSchema,
    mode: channelModeSchema.nullable(),
    phoneNumberId: z.string().max(64).nullable(),
    wabaId: z.string().max(64).nullable(),
    connectedAt: instant.nullable(),
    tokenExpiresAt: instant.nullable(),
    tokenInvalidAt: instant.nullable(),
  }),
  attendance: z.object({ last24h: windowSchema, last7d: windowSchema, last30d: windowSchema }),
  attention: z.object({
    stalledPending: count,
    unsentReplies: count,
    openHandoffs: count,
    tokenInvalid: z.boolean(),
    tokenExpiringSoon: z.boolean(),
  }),
  content: z.object({ documents: count, activeProducts: count, upcomingAppointments: count }),
});
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

// --- E2: contas ----------------------------------------------------------------------------------

export const accountListItemSchema = z.object({
  id,
  emailMasked: maskedEmail,
  status: accessStatusSchema,
  verified: z.boolean(),
  createdAt: instant,
  companies: count,
  hasSubscription: z.boolean(),
});
export type AccountListItem = z.infer<typeof accountListItemSchema>;

/** `GET /platform/accounts?status=&verified=&cursor=` (`PlatformAccountListResponse`). */
export const accountPageSchema = z.object({
  items: z.array(accountListItemSchema).max(50),
  nextCursor: cursor,
});
export type AccountPage = z.infer<typeof accountPageSchema>;

/**
 * `GET /platform/accounts/:accountId` (`PlatformAccountDetailResponse`), com o e-mail MASCARADO: abrir a
 * conta não grava nada (spec 045, D3).
 */
export const accountDetailSchema = z.object({
  billingEnabled: z.boolean(),
  id,
  emailMasked: maskedEmail,
  status: accessStatusSchema,
  verified: z.boolean(),
  createdAt: instant,
  companies: z
    .array(
      z.object({
        id,
        name: shortText,
        slug: shortText,
        status: companyStatusSchema,
        role: membershipRoleSchema,
        membershipStatus: accessStatusSchema,
      }),
    )
    .max(100),
  subscription: subscriptionSchema.nullable(),
});
export type AccountDetail = z.infer<typeof accountDetailSchema>;

/**
 * `GET /platform/accounts/:accountId/email` (`PlatformAccountEmailResponse`): o e-mail completo, só pelo
 * botão "Mostrar e-mail"; cada leitura grava `ACCOUNT_EMAIL_VIEWED` (D7 da 044, D3 da 045).
 */
export const accountEmailSchema = z.object({ email: z.string().min(3).max(320) });
export type AccountEmail = z.infer<typeof accountEmailSchema>;

// --- E2: cobrança --------------------------------------------------------------------------------

export const orderSchema = z.object({
  id,
  kind: z.enum(ORDER_KINDS),
  status: z.enum(ORDER_STATUSES),
  amountCents: cents,
  captureMethod: z.string().max(32).nullable(),
  createdAt: instant,
  paidAt: instant.nullable(),
  expiresAt: instant,
  periodStart: instant.nullable(),
  periodEnd: instant.nullable(),
  accountId: id,
});
export type Order = z.infer<typeof orderSchema>;

/** `GET /platform/billing/orders?status=&kind=&cursor=` (`PlatformOrderListResponse`). */
export const orderPageSchema = z.object({
  billingEnabled: z.boolean(),
  items: z.array(orderSchema).max(50),
  nextCursor: cursor,
});
export type OrderPage = z.infer<typeof orderPageSchema>;

export const noticeSchema = z.object({
  kind: z.enum(NOTICE_KINDS),
  windowStart: instant,
  createdAt: instant,
  accountId: id,
});
export type Notice = z.infer<typeof noticeSchema>;

/** `GET /platform/billing/notices?kind=&cursor=` (`PlatformNoticeListResponse`). */
export const noticePageSchema = z.object({
  billingEnabled: z.boolean(),
  items: z.array(noticeSchema).max(50),
  nextCursor: cursor,
});
export type NoticePage = z.infer<typeof noticePageSchema>;

// --- E2: saúde -----------------------------------------------------------------------------------

const resumeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disabled') }),
  z.object({ state: z.literal('not_run') }),
  z.object({
    state: z.literal('ran'),
    at: instant,
    resume: z.object({ ok: z.boolean(), scheduled: count, skippedLimit: count, failed: count }),
    clean: z.object({ ok: z.boolean(), completed: count, failed: count }),
  }),
]);
export type ResumeHealth = z.infer<typeof resumeSchema>;

const counterValue = z.number().nonnegative();

/** `GET /platform/health` (`PlatformHealthResponse`). */
export const healthSchema = z.object({
  checkedAt: instant,
  bootedAt: instant,
  database: z.enum(['up', 'down']),
  redis: z.enum(['up', 'down']),
  queue: z.discriminatedUnion('state', [
    z.object({ state: z.literal('disabled') }),
    z.object({ state: z.literal('unavailable') }),
    z.object({
      state: z.literal('ok'),
      jobs: z.record(z.string().regex(/^[a-z][a-z-]{0,31}$/), count),
    }),
  ]),
  resume: resumeSchema,
  /** Contadores do processo que respondeu, desde o boot (lista fixa da E2). */
  counters: z.object({
    attendanceFallbacks: counterValue,
    attendanceUnsentReplies: counterValue,
    channelSend: z.object({ ok: counterValue, error: counterValue }),
    queueJobsFailed: counterValue,
    processFatalErrors: counterValue,
    entitlementErrors: counterValue,
    usageMeterErrors: counterValue,
    billingNoticesFailed: counterValue,
    salesContactRequests: fixedKeys(SALES_CONTACT_RESULTS, counterValue),
  }),
});
export type Health = z.infer<typeof healthSchema>;

// --- Corpo das ações -----------------------------------------------------------------------------

/** Corpo de `POST /platform/companies/:companyId/suspend` e `.../reactivate` (204). */
export const actionBodySchema = z.object({ reason: z.enum(ACTION_REASONS) }).strict();

/**
 * Ações sobre a conta (spec 045, E2), todas `POST /platform/accounts/:accountId/<caminho>`. `code` (o
 * código novo do autenticador) só nas marcadas **[código]**: desativar. Respostas sem corpo: 204
 * (desativar, reativar, encerrar sessões) ou 202 (os dois e-mails).
 */
export const ACCOUNT_ACTIONS = {
  disable: { path: 'disable', code: true },
  enable: { path: 'enable', code: false },
  revokeSessions: { path: 'sessions/revoke', code: false },
  passwordReset: { path: 'password-reset', code: false },
  resendVerification: { path: 'verification/resend', code: false },
} as const;
export type AccountAction = keyof typeof ACCOUNT_ACTIONS;

/** Código de 6 dígitos do autenticador (o mesmo formato do login). */
export const confirmationCodeSchema = z.string().regex(/^[0-9]{6}$/);

/** Corpo das ações com confirmação reforçada (desativar): motivo e código. */
export const confirmedActionBodySchema = z
  .object({ reason: z.enum(ACTION_REASONS), code: confirmationCodeSchema })
  .strict();

// --- Spec 045, E3a: empresa e vínculos ----------------------------------------------------------

/** Papel de um vínculo (`MEMBERSHIP_ROLES`, na ordem da tela: dono primeiro). */
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** `POST /platform/companies/:companyId/rename` (204): o nome (1 a 120) e o motivo. */
export const renameBodySchema = z
  .object({ name: z.string().trim().min(1).max(120), reason: z.enum(ACTION_REASONS) })
  .strict();

/** `POST /platform/companies/:companyId/remove` (**[código]**, 204): o slug digitado e o código. */
export const removeCompanyBodySchema = z
  .object({
    reason: z.enum(ACTION_REASONS),
    slug: z.string().max(63),
    code: confirmationCodeSchema,
  })
  .strict();

/**
 * `POST /platform/companies/:companyId/memberships/:membershipId/role` (204): `code` só quando o papel
 * de origem ou o de destino é `OWNER` (**[código]**).
 */
export const roleBodySchema = z
  .object({
    role: z.enum(MEMBERSHIP_ROLES),
    reason: z.enum(ACTION_REASONS),
    code: confirmationCodeSchema.optional(),
  })
  .strict();
