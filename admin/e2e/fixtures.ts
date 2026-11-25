import type {
  AccountDetail,
  AccountEmail,
  AccountPage,
  CompanyDetail,
  CompanyPage,
  Health,
  Invitation,
  NoticePage,
  OrderPage,
  Overview,
} from '../src/contracts';

/**
 * Respostas falsas das rotas `/platform/*` (spec 044, E3), no formato da E2. Tipadas pelos contratos do
 * app e validadas por eles em `src/contracts.test.ts`: se o contrato mudar, estas fixturas e os testes do
 * Playwright mudam junto.
 */
export const ADMIN_EMAIL = 'dono@exemplo.test';
export const COMPANY_A = '0193a1b2-0000-7000-8000-00000000000a';
export const COMPANY_B = '0193a1b2-0000-7000-8000-00000000000b';
export const ACCOUNT_A = '0193a1b2-0000-7000-8000-0000000000a1';
export const ACCOUNT_B = '0193a1b2-0000-7000-8000-0000000000b1';
export const FULL_EMAIL = 'lucia.titular@exemplo.test';
const MEMBERSHIP_OWNER = '0193a1b2-0000-7000-8000-0000000000d1';
const MEMBERSHIP_AGENT = '0193a1b2-0000-7000-8000-0000000000d2';
export const MEMBERSHIP_LEGACY = '0193a1b2-0000-7000-8000-0000000000d3';
const MEMBERSHIP_B_OWNER = '0193a1b2-0000-7000-8000-0000000000d4';
const ORDER_ID = '0193a1b2-0000-7000-8000-0000000000f1';
const SUBSCRIPTION_ID = '0193a1b2-0000-7000-8000-0000000000c1';

export const overview: Overview = {
  generatedAt: '2026-11-24T12:00:00.000Z',
  billingEnabled: true,
  companies: { active: 12, suspended: 1 },
  accounts: { total: 20, verified: 17, unverified: 3, disabled: 0 },
  subscriptions: {
    byState: { TRIAL: 3, ACTIVE: 9, PAST_DUE: 0, CANCELLED: 0, EXPIRED: 0 },
    byPlan: { ESSENTIAL: 7, PROFESSIONAL: 5, SCALE: 0 },
    byAccess: { ok: 11, grace: 1, blocked: 0 },
  },
  channel: {
    byState: { CONNECTED: 10, TOKEN_INVALID: 1, NOT_CONNECTED: 2, LEGACY: 0 },
    byMode: { API_ONLY: 6, COEXISTENCE: 5 },
  },
  attendance: {
    last24h: { contactMessages: 1234, replies: 1200, fallbackReplies: 4 },
    last7d: { contactMessages: 8000, replies: 7900, fallbackReplies: 21 },
  },
  attention: {
    stalledPending: 2,
    unsentReplies: 0,
    tokenInvalid: 1,
    tokensExpiringSoon: 1,
    openHandoffs: 3,
  },
  paidOrdersThisMonth: { monthStart: '2026-11-01T03:00:00.000Z', count: 4, amountCents: 59_600 },
};

/** Cobrança desligada no overview. */
export const overviewBillingOff: Overview = {
  ...overview,
  billingEnabled: false,
  subscriptions: null,
  paidOrdersThisMonth: null,
};

export const companyA = {
  id: COMPANY_A,
  name: 'Padaria Aurora',
  slug: 'padaria-aurora',
  status: 'ACTIVE',
  createdAt: '2026-10-01T12:00:00.000Z',
  lastActivityAt: '2026-11-24T10:30:00.000Z',
  plan: 'PROFESSIONAL',
  access: 'ok',
  channelState: 'CONNECTED',
  activeMembers: 3,
  messages7d: 420,
  owner: { accountId: ACCOUNT_A, emailMasked: 'l***@exemplo.test' },
  owners: 1,
  removedAt: null,
} as const satisfies CompanyPage['items'][number];

export const companyB = {
  id: COMPANY_B,
  name: 'Oficina Boa Vista',
  slug: 'oficina-boa-vista',
  status: 'ACTIVE',
  createdAt: '2026-10-05T12:00:00.000Z',
  lastActivityAt: null,
  plan: null,
  access: null,
  channelState: 'TOKEN_INVALID',
  activeMembers: 1,
  messages7d: 0,
  owner: null,
  owners: 0,
  removedAt: null,
} as const satisfies CompanyPage['items'][number];

export const companyPage: CompanyPage = { items: [companyA, companyB], nextCursor: null };

const noHandoffs = {
  CONTACT_REQUESTED: 0,
  CANNOT_HELP: 0,
  COMPLAINT: 0,
  SENSITIVE: 0,
  OTHER: 0,
};

const emptyWindow = {
  activeConversations: 0,
  contactMessages: 0,
  replies: 0,
  fallbacks: 0,
  uncertainDeliveries: 0,
  handoffs: noHandoffs,
};

const subscription = {
  id: SUBSCRIPTION_ID,
  plan: { code: 'PROFESSIONAL', name: 'Profissional' },
  cycle: 'MONTHLY',
  modules: { schedule: true, inventory: false },
  status: 'ACTIVE',
  state: 'ACTIVE',
  access: 'ok',
  currentPeriodStart: '2026-11-01T03:00:00.000Z',
  currentPeriodEnd: '2026-12-01T03:00:00.000Z',
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  pendingChange: { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: true, stock: false },
} as const satisfies NonNullable<CompanyDetail['subscription']>;

export function companyDetail(
  status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  removedAt: string | null = null,
): CompanyDetail {
  return {
    billingEnabled: true,
    id: COMPANY_A,
    name: 'Padaria Aurora',
    slug: 'padaria-aurora',
    status,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-11-20T12:00:00.000Z',
    removedAt,
    hasPersona: true,
    onboarding: {
      dismissed: false,
      steps: { persona: true, knowledge: false, schedule: true, inventory: false },
    },
    modules: { schedule: true, inventory: false },
    memberships: [
      { role: 'OWNER', status: 'ACTIVE', count: 1 },
      { role: 'AGENT', status: 'ACTIVE', count: 2 },
    ],
    people: [
      {
        membershipId: MEMBERSHIP_OWNER,
        accountId: ACCOUNT_A,
        emailMasked: 'l***@exemplo.test',
        role: 'OWNER',
        status: 'ACTIVE',
        createdAt: '2026-10-01T12:00:00.000Z',
        account: { status: 'ACTIVE', verified: true },
      },
      {
        membershipId: MEMBERSHIP_AGENT,
        accountId: ACCOUNT_B,
        emailMasked: 'm***@exemplo.test',
        role: 'AGENT',
        status: 'ACTIVE',
        createdAt: '2026-10-03T12:00:00.000Z',
        account: { status: 'DISABLED', verified: false },
      },
      {
        membershipId: MEMBERSHIP_LEGACY,
        accountId: null,
        emailMasked: 'v***@exemplo.test',
        role: 'AGENT',
        status: 'ACTIVE',
        createdAt: '2026-10-04T12:00:00.000Z',
        account: null,
      },
    ],
    peopleTotal: 3,
    owner: { accountId: ACCOUNT_A, emailMasked: 'l***@exemplo.test' },
    owners: 1,
    pendingInvitations: 2,
    holder: {
      accountId: ACCOUNT_A,
      emailVerified: true,
      status: 'ACTIVE',
      createdAt: '2026-10-01T12:00:00.000Z',
    },
    subscription,
    usage: {
      windowStart: '2026-11-01T03:00:00.000Z',
      windowEnd: '2026-12-01T03:00:00.000Z',
      replies: { used: 1250, limit: 5000 },
      tokens: { used: 1_200_000, limit: 10_000_000 },
    },
    channel: {
      state: 'CONNECTED',
      mode: 'COEXISTENCE',
      phoneNumberId: '109876543210',
      wabaId: '209876543210',
      connectedAt: '2026-10-02T12:00:00.000Z',
      tokenExpiresAt: '2026-12-20T12:00:00.000Z',
      tokenInvalidAt: null,
    },
    attendance: {
      last24h: {
        activeConversations: 12,
        contactMessages: 60,
        replies: 58,
        fallbacks: 1,
        uncertainDeliveries: 0,
        handoffs: { ...noHandoffs, CONTACT_REQUESTED: 1 },
      },
      last7d: emptyWindow,
      last30d: emptyWindow,
    },
    attention: {
      stalledPending: 2,
      unsentReplies: 0,
      openHandoffs: 1,
      tokenInvalid: false,
      tokenExpiringSoon: false,
    },
    content: { documents: 4, activeProducts: 18, upcomingAppointments: 6 },
  };
}

/**
 * Empresa B (spec 045, E1): sem dono ativo (o único dono é um vínculo desativado, da CLI, sem conta), sem
 * assinatura e com a cobrança desligada: o aviso "Empresa sem dono ativo" aparece.
 */
export function companyDetailB(): CompanyDetail {
  return {
    ...companyDetail(),
    billingEnabled: false,
    id: COMPANY_B,
    name: 'Oficina Boa Vista',
    slug: 'oficina-boa-vista',
    memberships: [{ role: 'OWNER', status: 'DISABLED', count: 1 }],
    people: [
      {
        membershipId: MEMBERSHIP_B_OWNER,
        accountId: null,
        emailMasked: 'o***@exemplo.test',
        role: 'OWNER',
        status: 'DISABLED',
        createdAt: '2026-10-05T12:00:00.000Z',
        account: null,
      },
    ],
    peopleTotal: 1,
    owner: null,
    owners: 0,
    pendingInvitations: 0,
    holder: null,
    subscription: null,
    usage: null,
  };
}

export const accountPage: AccountPage = {
  items: [
    {
      id: ACCOUNT_A,
      emailMasked: 'l***@exemplo.test',
      status: 'ACTIVE',
      verified: true,
      createdAt: '2026-10-01T12:00:00.000Z',
      companies: 1,
      hasSubscription: true,
    },
  ],
  nextCursor: null,
};

/** `GET /platform/accounts/:accountId`: mascarado, não grava nada (spec 045, D3). */
export const accountDetail: AccountDetail = {
  billingEnabled: true,
  id: ACCOUNT_A,
  emailMasked: 'l***@exemplo.test',
  status: 'ACTIVE',
  verified: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  companies: [
    {
      id: COMPANY_A,
      name: 'Padaria Aurora',
      slug: 'padaria-aurora',
      status: 'ACTIVE',
      role: 'OWNER',
      membershipStatus: 'ACTIVE',
    },
  ],
  subscription,
};

/** `GET /platform/accounts/:accountId/email`: o completo, só pelo "Mostrar e-mail" (auditado). */
export const accountEmail: AccountEmail = { email: FULL_EMAIL };

export const orderPage: OrderPage = {
  billingEnabled: true,
  items: [
    {
      id: ORDER_ID,
      kind: 'RENEWAL',
      status: 'PAID',
      amountCents: 14_900,
      captureMethod: 'pix',
      createdAt: '2026-11-01T12:00:00.000Z',
      paidAt: '2026-11-01T12:05:00.000Z',
      expiresAt: '2026-11-02T12:00:00.000Z',
      periodStart: '2026-11-01T03:00:00.000Z',
      periodEnd: '2026-12-01T03:00:00.000Z',
      accountId: ACCOUNT_A,
    },
  ],
  nextCursor: null,
};

export const noticePage: NoticePage = {
  billingEnabled: true,
  items: [
    {
      kind: 'QUOTA_REPLIES_80',
      windowStart: '2026-11-01T03:00:00.000Z',
      createdAt: '2026-11-20T12:00:00.000Z',
      accountId: ACCOUNT_A,
    },
  ],
  nextCursor: null,
};

/** Cobrança desligada: as listas de pedidos e avisos vêm vazias, com `billingEnabled: false`. */
export const billingOffPage: OrderPage & NoticePage = {
  billingEnabled: false,
  items: [],
  nextCursor: null,
};

export const health: Health = {
  checkedAt: '2026-11-24T12:00:00.000Z',
  bootedAt: '2026-11-24T08:00:00.000Z',
  database: 'up',
  redis: 'up',
  queue: {
    state: 'ok',
    jobs: { waiting: 0, active: 1, delayed: 0, completed: 40, failed: 2 },
  },
  resume: {
    state: 'ran',
    at: '2026-11-24T11:55:00.000Z',
    resume: { ok: true, scheduled: 0, skippedLimit: 0, failed: 0 },
    clean: { ok: true, completed: 12, failed: 0 },
  },
  counters: {
    attendanceFallbacks: 3,
    attendanceUnsentReplies: 0,
    channelSend: { ok: 120, error: 1 },
    queueJobsFailed: 0,
    processFatalErrors: 0,
    entitlementErrors: 0,
    usageMeterErrors: 0,
    billingNoticesFailed: 0,
    salesContactRequests: {
      sent: 2,
      failed: 0,
      spam: 0,
      too_fast: 0,
      capped: 0,
      daily_cap: 0,
      invalid: 0,
      expired: 0,
    },
  },
};

/** Spec 045, E3b: um convite pendente da empresa A, feito pela equipe (e-mail mascarado). */
export const pendingInvitation = {
  id: '0193a1b2-0000-7000-8000-0000000000f1',
  emailMasked: 'r***@exemplo.test',
  role: 'AGENT',
  state: 'PENDING',
  invitedBy: 'membership',
  createdAt: '2026-11-24T12:00:00.000Z',
  expiresAt: '2026-12-01T12:00:00.000Z',
  lastSentAt: '2026-11-24T12:00:00.000Z',
  sendCount: 1,
} as const satisfies Invitation;

/** E-mail que já é de uma pessoa da empresa A: convidar dá 409 `MEMBER_ALREADY_EXISTS`. */
export const MEMBER_EMAIL = 'membro.existente@exemplo.test';
