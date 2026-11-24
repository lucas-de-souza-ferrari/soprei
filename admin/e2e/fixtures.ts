import type {
  AccountDetail,
  AccountPage,
  CompanyDetail,
  CompanyPage,
  Health,
  NoticePage,
  OrderPage,
  Overview,
} from '../src/contracts';

/**
 * Respostas falsas das rotas `/platform/*` (spec 044, E3). Tipadas pelos contratos do app e validadas por
 * eles em `src/contracts.test.ts`: se o contrato mudar, estas fixturas e os testes do Playwright mudam
 * junto.
 */
export const ADMIN_EMAIL = 'dono@exemplo.test';
export const COMPANY_A = '0193a1b2-0000-7000-8000-00000000000a';
export const COMPANY_B = '0193a1b2-0000-7000-8000-00000000000b';
export const ACCOUNT_A = '0193a1b2-0000-7000-8000-0000000000a1';
export const FULL_EMAIL = 'lucia.titular@exemplo.test';
const ORDER_ID = '0193a1b2-0000-7000-8000-0000000000f1';

export const overview: Overview = {
  billingEnabled: true,
  companies: [
    { key: 'ACTIVE', count: 12 },
    { key: 'SUSPENDED', count: 1 },
  ],
  accounts: { total: 20, verified: 17, unverified: 3, disabled: 0 },
  subscriptions: {
    byState: [
      { key: 'ACTIVE', count: 9 },
      { key: 'TRIAL', count: 3 },
    ],
    byPlan: [
      { key: 'ESSENTIAL', count: 7 },
      { key: 'PROFESSIONAL', count: 5 },
    ],
  },
  channel: {
    byState: [
      { key: 'CONNECTED', count: 10 },
      { key: 'TOKEN_INVALID', count: 1 },
      { key: 'NOT_CONNECTED', count: 2 },
    ],
    byMode: [
      { key: 'API_ONLY', count: 6 },
      { key: 'COEXISTENCE', count: 5 },
    ],
  },
  traffic: {
    last24h: { contactMessages: 1234, replies: 1200, fallbacks: 4 },
    last7d: { contactMessages: 8000, replies: 7900, fallbacks: 21 },
  },
  attention: {
    pendingMessages: 2,
    unsentReplies: 0,
    tokenInvalid: 1,
    tokenExpiring: 1,
    openHandoffs: 3,
  },
  paidThisMonth: { count: 4, amountCents: 59_600 },
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
} as const satisfies CompanyPage['items'][number];

export const companyPage: CompanyPage = { items: [companyA, companyB], nextCursor: null };

const emptyWindow = {
  activeConversations: 0,
  contactMessages: 0,
  replies: 0,
  fallbacks: 0,
  uncertainDeliveries: 0,
  handoffs: [],
};

export function companyDetail(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE'): CompanyDetail {
  return {
    id: COMPANY_A,
    name: 'Padaria Aurora',
    slug: 'padaria-aurora',
    status,
    createdAt: '2026-10-01T12:00:00.000Z',
    lastActivityAt: '2026-11-24T10:30:00.000Z',
    hasPersona: true,
    modules: ['SCHEDULE'],
    onboarding: [
      { key: 'persona', done: true },
      { key: 'knowledge', done: false },
    ],
    members: [
      { role: 'OWNER', status: 'ACTIVE', count: 1 },
      { role: 'AGENT', status: 'ACTIVE', count: 2 },
    ],
    owner: {
      accountId: ACCOUNT_A,
      emailVerified: true,
      status: 'ACTIVE',
      createdAt: '2026-10-01T12:00:00.000Z',
    },
    billingEnabled: true,
    subscription: {
      plan: 'PROFESSIONAL',
      cycle: 'MONTHLY',
      modules: ['SCHEDULE'],
      state: 'ACTIVE',
      access: 'ok',
      periodStart: '2026-11-01T03:00:00.000Z',
      periodEnd: '2026-12-01T03:00:00.000Z',
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      usage: {
        windowStart: '2026-11-01T03:00:00.000Z',
        windowEnd: '2026-12-01T03:00:00.000Z',
        replies: 1250,
        repliesQuota: 5000,
        tokens: 1_200_000,
        tokensQuota: 10_000_000,
      },
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
        handoffs: [{ key: 'CONTACT_REQUESTED', count: 1 }],
      },
      last7d: emptyWindow,
      last30d: emptyWindow,
    },
    attention: {
      pendingMessages: 2,
      unsentReplies: 0,
      tokenInvalid: false,
      tokenExpiring: false,
      openHandoffs: 1,
    },
    content: { documents: 4, activeProducts: 18, upcomingBookings7d: 6 },
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

export const accountDetail: AccountDetail = {
  id: ACCOUNT_A,
  email: FULL_EMAIL,
  status: 'ACTIVE',
  verified: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  companies: [{ id: COMPANY_A, name: 'Padaria Aurora', slug: 'padaria-aurora', role: 'OWNER' }],
  subscription: {
    plan: 'PROFESSIONAL',
    cycle: 'MONTHLY',
    state: 'ACTIVE',
    access: 'ok',
    periodEnd: '2026-12-01T03:00:00.000Z',
  },
};

export const orderPage: OrderPage = {
  items: [
    {
      id: ORDER_ID,
      kind: 'RENEWAL',
      status: 'PAID',
      amountCents: 14_900,
      captureMethod: 'pix',
      createdAt: '2026-11-01T12:00:00.000Z',
      paidAt: '2026-11-01T12:05:00.000Z',
      expiresAt: null,
      periodStart: '2026-11-01T03:00:00.000Z',
      periodEnd: '2026-12-01T03:00:00.000Z',
      accountId: ACCOUNT_A,
    },
  ],
  nextCursor: null,
};

export const noticePage: NoticePage = {
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

export const health: Health = {
  checkedAt: '2026-11-24T12:00:00.000Z',
  bootedAt: '2026-11-24T08:00:00.000Z',
  database: 'up',
  redis: 'up',
  queue: {
    status: 'ok',
    counts: [
      { key: 'waiting', count: 0 },
      { key: 'failed', count: 2 },
    ],
  },
  resume: {
    status: 'ran',
    at: '2026-11-24T11:55:00.000Z',
    result: 'ok',
    counts: [{ key: 'resumed', count: 0 }],
  },
  cleanup: { status: 'disabled' },
  counters: [
    { name: 'attendance_fallbacks_total', label: null, value: 3 },
    { name: 'channel_send_total', label: 'ok', value: 120 },
  ],
};
