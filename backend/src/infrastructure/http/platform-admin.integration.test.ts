import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import { SITE_TEST_CONTACT_REF } from '../../application/attendance/contact-label.js';
import { CompanyService } from '../../application/companies/company.service.js';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { PlatformMonitorService } from '../../application/platform/platform-monitor.service.js';
import { factorFingerprint } from '../../application/platform/totp-second-factor.js';
import type { Company, PlatformAdminId } from '../../domain/index.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { PLATFORM_COOKIE } from '../../presentation/platform/platform-auth.controller.js';
import type {
  PlatformAccountDetailResponse,
  PlatformAccountEmailResponse,
  PlatformAccountListResponse,
  PlatformCompanyDetailResponse,
  PlatformCompanyListResponse,
  PlatformHealthResponse,
  PlatformNoticeListResponse,
  PlatformOrderListResponse,
  PlatformOverviewResponse,
} from '../../presentation/platform/platform-monitor.controller.js';
import { type AuthRedisHandle, createAuthRedis } from '../auth/auth-redis.js';
import { RedisPlatformSessionStore } from '../auth/redis-platform-session-store.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import {
  createDatabase,
  type Database,
  PrismaBillingRepository,
  PrismaCompanyRepository,
  PrismaOnboardingStore,
  PrismaPlatformAdminRepository,
  PrismaPlatformAuditRepository,
  PrismaPlatformCompanyUnitOfWork,
  PrismaPlatformReadModel,
} from '../database/index.js';
import { createMetrics, readPlatformProcessCounters } from '../metrics/index.js';
import { buildServer } from './server.js';

// Spec 044, E2: o admin da plataforma de ponta a ponta com Postgres (soprei_test) e Redis (/15) reais.
// Duas empresas com números diferentes e textos-sentinela em todo conteúdo: nenhuma resposta de
// /platform/*, nenhum log e o /metrics podem conter um sentinela; A nunca recebe números de B.

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const ORIGIN = 'https://soadm.exemplo.test';
const WRITE = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const METRICS_TOKEN = 'm'.repeat(32);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BILLING = { graceDays: 5, trialDays: 7, trialTokens: 600_000, trialReplies: 100 };

const tag = randomBytes(4).toString('hex').toUpperCase();
const S = (label: string): string => `SENTINELA-${label}-${tag}`;
const PHONE_A = `55119${String(randomInt(10_000_000, 99_999_999))}`;
const PHONE_B = `55219${String(randomInt(10_000_000, 99_999_999))}`;
const PHONE_D = `55319${String(randomInt(10_000_000, 99_999_999))}`;
const NUMBER_A = String(randomInt(100_000_000, 999_999_999)) + String(randomInt(100_000, 999_999));
const NUMBER_C = String(randomInt(100_000_000, 999_999_999)) + String(randomInt(100_000, 999_999));
const NUMBER_D = String(randomInt(100_000_000, 999_999_999)) + String(randomInt(100_000, 999_999));
const ACCOUNT_EMAIL = `sentinela-conta-${tag.toLowerCase()}@exemplo.test`;
const MEMBER_EMAIL_A = `sentinela-membro-a-${tag.toLowerCase()}@exemplo.test`;

const CONTENT_SENTINELS = [
  S('MSG-A1'),
  S('MSG-A2'),
  S('MSG-A3'),
  S('MSG-A4'),
  S('MSG-A5'),
  S('REPLY-A1'),
  S('REPLY-A2'),
  S('REPLY-A3'),
  S('REPLY-A4'),
  S('MSG-B1'),
  S('REPLY-B1'),
  S('MSG-C1'),
  S('REPLY-C1'),
  S('MSG-D1'),
  S('REPLY-D1'),
  S('PERSONA'),
  S('DOC-TITLE'),
  S('DOC-PREVIEW'),
  S('CHUNK'),
  S('PROD-NAME'),
  S('PROD-SKU'),
  S('PROD-DESC'),
  S('SERVICE'),
  S('RESOURCE'),
  S('CUSTOMER'),
  S('TOKEN-CIPHER'),
  S('PIN-CIPHER'),
  S('CHECKOUT'),
  S('TXREF'),
  S('SLUG'),
  S('WAMID'),
  PHONE_A,
  PHONE_B,
  PHONE_D,
  MEMBER_EMAIL_A,
];

let database: Database;
let tenants: TestTenants;
let redis: RedisHandle;
let authRedis: AuthRedisHandle;
let app: FastifyInstance;
let testAuth: ReturnType<typeof buildTestAuth>;
const logs = captureLogs();
let cookie: string;
let adminId: PlatformAdminId;
let companyA: Company;
let companyB: Company;
/** Ativa, com número, só com a conversa do "Testar" do site (revisão da E2, I2). */
let companyC: Company;
/** Suspensa, com número, com uma pendente parada e uma resposta não enviada de verdade. */
let companyD: Company;
let conversationA: string;
let accountA: string;
let subscriptionA: string;
let orderA: string;
const createdAdmins: string[] = [];
const createdAccounts: string[] = [];
/** Toda resposta de /platform/* deste arquivo, para a varredura de sentinelas no fim. */
const platformBodies: { url: string; body: string }[] = [];

const db = () => database.prisma;

async function get(url: string, headers: Record<string, string> = { cookie }) {
  const response = await app.inject({ method: 'GET', url, headers });
  if (url.startsWith('/platform/')) platformBodies.push({ url, body: response.body });
  return response;
}

async function post(url: string, payload: unknown): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { ...WRITE, cookie },
    payload: payload as object,
  });
  platformBodies.push({ url, body: response.body });
  return response;
}

async function overview(): Promise<PlatformOverviewResponse> {
  const response = await get('/platform/overview');
  assert.equal(response.statusCode, 200, response.body);
  return response.json<PlatformOverviewResponse>();
}

let baseline: PlatformOverviewResponse;

async function seed(now: Date): Promise<void> {
  companyA = await tenants.createCompany('plat-a', NUMBER_A);
  companyB = await tenants.createCompany('plat-b');
  const at = (ms: number): Date => new Date(now.getTime() - ms);

  const account = await db().account.create({
    data: { email: ACCOUNT_EMAIL, passwordHash: 'x', emailVerifiedAt: now },
  });
  accountA = account.id;
  createdAccounts.push(account.id);
  const subscription = await new PrismaBillingRepository(db()).ensureTrial(accountA, now, BILLING);
  subscriptionA = subscription.id;
  await db().company.updateMany({
    where: { id: companyA.id },
    data: { subscriptionId: subscriptionA, persona: S('PERSONA') },
  });
  const ownerA = await db().membership.create({
    data: {
      companyId: companyA.id,
      email: MEMBER_EMAIL_A,
      passwordHash: 'x',
      role: 'OWNER',
      accountId: accountA,
    },
  });
  await db().membership.create({
    data: {
      companyId: companyB.id,
      email: `b-${tag.toLowerCase()}@exemplo.test`,
      passwordHash: 'x',
      role: 'OWNER',
    },
  });

  // Empresa A: 5 mensagens do contato, 4 respostas (1 fallback, 1 não enviada, 1 de entrega incerta),
  // 1 pendente parada há 10 min e 1 pedido de atendimento humano aberto.
  const convA = await db().conversation.create({
    data: { companyId: companyA.id, contactRef: PHONE_A },
  });
  conversationA = convA.id;
  const message = (data: {
    role: 'USER' | 'ASSISTANT';
    content: string;
    createdAt: Date;
    conversationId?: string;
    companyId?: string;
    sentAt?: Date | null;
    isFallback?: boolean;
    answeredById?: string | null;
    deliveryUncertainAt?: Date | null;
    externalId?: string | null;
  }) =>
    db().message.create({
      data: {
        companyId: data.companyId ?? companyA.id,
        conversationId: data.conversationId ?? convA.id,
        role: data.role,
        content: data.content,
        createdAt: data.createdAt,
        sentAt: data.sentAt ?? null,
        isFallback: data.isFallback ?? false,
        answeredById: data.answeredById ?? null,
        deliveryUncertainAt: data.deliveryUncertainAt ?? null,
        externalId: data.externalId ?? null,
      },
    });
  const reply1 = await message({
    role: 'ASSISTANT',
    content: S('REPLY-A1'),
    createdAt: at(50 * MINUTE),
    sentAt: at(50 * MINUTE),
  });
  await message({
    role: 'USER',
    content: S('MSG-A1'),
    createdAt: at(55 * MINUTE),
    answeredById: reply1.id,
    externalId: S('WAMID'),
  });
  await message({
    role: 'USER',
    content: S('MSG-A2'),
    createdAt: at(54 * MINUTE),
    answeredById: reply1.id,
  });
  const reply2 = await message({
    role: 'ASSISTANT',
    content: S('REPLY-A2'),
    createdAt: at(40 * MINUTE),
    sentAt: at(40 * MINUTE),
    isFallback: true,
  });
  await message({
    role: 'USER',
    content: S('MSG-A3'),
    createdAt: at(41 * MINUTE),
    answeredById: reply2.id,
  });
  const reply3 = await message({
    role: 'ASSISTANT',
    content: S('REPLY-A3'),
    createdAt: at(20 * MINUTE),
  });
  await message({
    role: 'USER',
    content: S('MSG-A4'),
    createdAt: at(21 * MINUTE),
    answeredById: reply3.id,
  });
  await message({
    role: 'ASSISTANT',
    content: S('REPLY-A4'),
    createdAt: at(15 * MINUTE),
    deliveryUncertainAt: at(15 * MINUTE),
  });
  await message({ role: 'USER', content: S('MSG-A5'), createdAt: at(10 * MINUTE) });
  await db().notification.create({
    data: {
      companyId: companyA.id,
      kind: 'HUMAN_HANDOFF',
      reason: 'COMPLAINT',
      conversationId: convA.id,
      messageId: reply2.id,
      status: 'OPEN',
    },
  });

  // Empresa B: 1 mensagem e 1 resposta enviada.
  const convB = await db().conversation.create({
    data: { companyId: companyB.id, contactRef: PHONE_B },
  });
  const replyB = await message({
    companyId: companyB.id,
    conversationId: convB.id,
    role: 'ASSISTANT',
    content: S('REPLY-B1'),
    createdAt: at(30 * MINUTE),
    sentAt: at(30 * MINUTE),
  });
  await message({
    companyId: companyB.id,
    conversationId: convB.id,
    role: 'USER',
    content: S('MSG-B1'),
    createdAt: at(31 * MINUTE),
    answeredById: replyB.id,
  });

  // Conteúdo de A: documento, produto, serviço, recurso e uma reserva amanhã; canal com token cifrado.
  const doc = await db().knowledgeDocument.create({
    data: {
      companyId: companyA.id,
      title: S('DOC-TITLE'),
      charCount: 10,
      chunkCount: 1,
      preview: S('DOC-PREVIEW'),
      createdByMembershipId: ownerA.id,
    },
  });
  await db().knowledgeChunk.create({
    data: {
      companyId: companyA.id,
      documentId: doc.id,
      position: 0,
      content: S('CHUNK'),
      searchText: S('CHUNK').toLowerCase(),
    },
  });
  await db().product.create({
    data: {
      companyId: companyA.id,
      sku: S('PROD-SKU'),
      name: S('PROD-NAME'),
      description: S('PROD-DESC'),
      priceCents: 100,
      quantity: 3,
      searchText: S('PROD-NAME').toLowerCase(),
    },
  });
  const resource = await db().scheduleResource.create({
    data: { companyId: companyA.id, name: S('RESOURCE') },
  });
  const service = await db().scheduleService.create({
    data: { companyId: companyA.id, name: S('SERVICE'), durationMinutes: 30 },
  });
  const startsAt = new Date(Math.ceil((now.getTime() + DAY) / (30 * MINUTE)) * 30 * MINUTE);
  await db().appointment.create({
    data: {
      companyId: companyA.id,
      resourceId: resource.id,
      serviceId: service.id,
      kind: 'BOOKING',
      status: 'CONFIRMED',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * MINUTE),
      blockedUntil: new Date(startsAt.getTime() + 30 * MINUTE),
      customerLabel: S('CUSTOMER'),
      contactRef: PHONE_A,
      source: 'PANEL',
      createdByMembershipId: ownerA.id,
    },
  });
  await db().channelConnection.create({
    data: {
      companyId: companyA.id,
      wabaId: String(randomInt(100_000_000, 999_999_999)),
      tokenCiphertext: S('TOKEN-CIPHER'),
      registrationPinCiphertext: S('PIN-CIPHER'),
      tokenExpiresAt: new Date(now.getTime() + 3 * DAY),
    },
  });

  // Cobrança de A: pedido pago com link, referência e slug do provedor; uso da janela; um aviso.
  const order = await db().paymentOrder.create({
    data: {
      subscriptionId: subscriptionA,
      kind: 'NEW',
      amountCents: 12_345,
      breakdown: { plan: 'ESSENTIAL' },
      status: 'PAID',
      checkoutUrl: `https://checkout.exemplo.test/${S('CHECKOUT')}`,
      providerTransactionRef: S('TXREF'),
      providerSlug: S('SLUG'),
      captureMethod: 'pix',
      paidAt: now,
      expiresAt: new Date(now.getTime() + DAY),
    },
  });
  orderA = order.id;
  await db().usageCounter.create({
    data: {
      subscriptionId: subscriptionA,
      windowStart: subscription.currentPeriodStart,
      tokens: 777n,
      sentMessages: 4n,
    },
  });
  await db().paymentNotice.create({
    data: {
      subscriptionId: subscriptionA,
      kind: 'PAYMENT_RECEIVED',
      windowStart: subscription.currentPeriodStart,
    },
  });

  // Revisão da E2 (I2): o "Testar" do site (empresa C, ativa e com número) grava a resposta sem `sent_at`
  // e nunca conta como "precisa de atenção"; a empresa D, suspensa, tem uma pendente parada e uma resposta
  // não enviada de verdade, e também não conta (só empresa ativa). As duas entram no volume.
  companyC = await tenants.createCompany('plat-c', NUMBER_C);
  const convC = await db().conversation.create({
    data: { companyId: companyC.id, contactRef: SITE_TEST_CONTACT_REF },
  });
  await message({
    companyId: companyC.id,
    conversationId: convC.id,
    role: 'USER',
    content: S('MSG-C1'),
    createdAt: at(12 * MINUTE),
  });
  await message({
    companyId: companyC.id,
    conversationId: convC.id,
    role: 'ASSISTANT',
    content: S('REPLY-C1'),
    createdAt: at(11 * MINUTE),
  });
  companyD = await tenants.createCompany('plat-d', NUMBER_D);
  await db().company.updateMany({ where: { id: companyD.id }, data: { status: 'SUSPENDED' } });
  const convD = await db().conversation.create({
    data: { companyId: companyD.id, contactRef: PHONE_D },
  });
  await message({
    companyId: companyD.id,
    conversationId: convD.id,
    role: 'USER',
    content: S('MSG-D1'),
    createdAt: at(12 * MINUTE),
  });
  await message({
    companyId: companyD.id,
    conversationId: convD.id,
    role: 'ASSISTANT',
    content: S('REPLY-D1'),
    createdAt: at(11 * MINUTE),
  });
}

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  redis = createRedis(config, logs.logger);
  authRedis = createAuthRedis(config, logs.logger);
  assert.ok(await authRedis.waitUntilReady(5_000));

  const admins = new PrismaPlatformAdminRepository(database.prisma);
  const admin = await admins.create({
    email: `plat-${tag.toLowerCase()}@exemplo.test`,
    passwordHash: 'x',
  });
  adminId = admin.id;
  createdAdmins.push(admin.id);
  const ciphertext = `v1.t1.${randomBytes(12).toString('base64url')}.tag.corpo`;
  await admins.setTotpSecret(admin.id, ciphertext);
  const sessions = new RedisPlatformSessionStore(
    authRedis.client,
    keyspace.scopedPrefix('platform-admin-e2'),
    1_800,
    43_200,
  );
  const secret = await sessions.create(admin.id, factorFingerprint(ciphertext));
  cookie = `${PLATFORM_COOKIE}=${secret}`;

  const metrics = createMetrics();
  const audit = new PrismaPlatformAuditRepository(database.prisma);
  testAuth = buildTestAuth({ logger: logs.logger });
  app = buildServer({
    logger: logs.logger,
    readiness: { database: () => database.check(), redis: () => redis.check() },
    metrics,
    metricsToken: METRICS_TOKEN,
    auth: testAuth.service,
    admin: {
      companies: new CompanyService(new PrismaCompanyRepository(database.prisma)),
      // Só para as rotas de conversa existirem: a plataforma nunca chega a chamá-las (403 antes).
      attendance: {} as unknown as AttendanceService,
    },
    platform: {
      auth: new PlatformAuthService({
        credentials: {
          verifyPlatformCredentials: () => Promise.reject(new Error('sem login aqui')),
        },
        admins,
        sessions,
        audit,
        logger: logs.logger,
        metrics,
      }),
      origin: ORIGIN,
      maxAgeSeconds: 43_200,
      monitor: new PlatformMonitorService({
        reads: new PrismaPlatformReadModel(database.prisma),
        onboarding: new PrismaOnboardingStore(database.prisma),
        companies: new PrismaPlatformCompanyUnitOfWork(database.prisma),
        audit,
        billing: BILLING,
        health: {
          database: () => database.check(),
          redis: () => redis.check(),
          counters: () => readPlatformProcessCounters(metrics.registry),
          bootedAt: new Date(),
        },
        logger: logs.logger,
        metrics,
      }),
    },
  });
  await app.ready();
  baseline = await overview();
  await seed(new Date());
});

after(async () => {
  try {
    await app.close();
    await tenants.cleanup();
    await db().platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
    await db().usageCounter.deleteMany({ where: { subscriptionId: subscriptionA } });
    await db().paymentNotice.deleteMany({ where: { subscriptionId: subscriptionA } });
    await db().paymentOrder.deleteMany({ where: { subscriptionId: subscriptionA } });
    await db().subscription.deleteMany({ where: { accountId: { in: createdAccounts } } });
    await db().account.deleteMany({ where: { id: { in: createdAccounts } } });
    await db().platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
    await keyspace.cleanup(redis.client);
  } finally {
    await authRedis.close();
    await redis.close();
    await database.close();
  }
});

describe('admin da plataforma com Postgres e Redis reais (spec 044, E2)', () => {
  it('overview soma A e B corretamente (diferença para antes dos dados deste teste)', async () => {
    const now = await overview();
    const delta = (pick: (o: PlatformOverviewResponse) => number): number =>
      pick(now) - pick(baseline);
    assert.equal(
      delta((o) => o.companies.active),
      3,
    );
    assert.equal(
      delta((o) => o.companies.suspended),
      1,
    );
    assert.equal(
      delta((o) => o.accounts.total),
      1,
    );
    assert.equal(
      delta((o) => o.accounts.verified),
      1,
    );
    assert.equal(
      delta((o) => o.channel.byState.CONNECTED),
      1,
    );
    assert.equal(
      delta((o) => o.channel.byState.NOT_CONNECTED),
      1,
    );
    assert.equal(
      delta((o) => o.channel.byMode.API_ONLY),
      1,
    );
    // Volume: A (5 e 4), B (1 e 1), C e D (1 e 1 cada).
    assert.equal(
      delta((o) => o.attendance.last24h.contactMessages),
      8,
    );
    assert.equal(
      delta((o) => o.attendance.last24h.replies),
      7,
    );
    assert.equal(
      delta((o) => o.attendance.last24h.fallbackReplies),
      1,
    );
    assert.equal(
      delta((o) => o.attendance.last7d.contactMessages),
      8,
    );
    // Só as de A: nem o "Testar" de C nem a empresa suspensa D (revisão da E2, I2).
    assert.equal(
      delta((o) => o.attention.stalledPending),
      1,
    );
    assert.equal(
      delta((o) => o.attention.unsentReplies),
      1,
    );
    assert.equal(
      delta((o) => o.attention.openHandoffs),
      1,
    );
    assert.equal(
      delta((o) => o.attention.tokensExpiringSoon),
      1,
    );
    assert.equal(
      delta((o) => o.subscriptions?.byState.TRIAL ?? 0),
      1,
    );
    assert.equal(
      delta((o) => o.subscriptions?.byPlan.ESSENTIAL ?? 0),
      1,
    );
    assert.equal(
      delta((o) => o.paidOrdersThisMonth?.count ?? 0),
      1,
    );
    assert.equal(
      delta((o) => o.paidOrdersThisMonth?.amountCents ?? 0),
      12_345,
    );
  });

  it('o detalhe da empresa A traz só números de A; o de B, só os de B', async () => {
    const a = (
      await get(`/platform/companies/${companyA.id}`)
    ).json<PlatformCompanyDetailResponse>();
    const b = (
      await get(`/platform/companies/${companyB.id}`)
    ).json<PlatformCompanyDetailResponse>();

    assert.equal(a.id, companyA.id);
    assert.equal(a.hasPersona, true);
    assert.deepEqual(a.onboarding.steps, {
      persona: true,
      knowledge: true,
      schedule: true,
      inventory: true,
    });
    assert.deepEqual(a.memberships, [{ role: 'OWNER', status: 'ACTIVE', count: 1 }]);
    assert.equal(a.holder?.accountId, accountA);
    assert.equal(a.holder.emailVerified, true);
    assert.equal(a.subscription?.id, subscriptionA);
    assert.equal(a.subscription.state, 'TRIAL');
    assert.deepEqual(a.usage?.tokens.used, 777);
    assert.deepEqual(a.usage.replies.used, 4);
    assert.equal(a.channel.state, 'CONNECTED');
    assert.equal(a.channel.mode, 'API_ONLY');
    assert.equal(a.channel.phoneNumberId, NUMBER_A);
    assert.deepEqual(
      {
        conversations: a.attendance.last24h.activeConversations,
        contact: a.attendance.last24h.contactMessages,
        replies: a.attendance.last24h.replies,
        fallbacks: a.attendance.last24h.fallbacks,
        uncertain: a.attendance.last24h.uncertainDeliveries,
        complaints: a.attendance.last24h.handoffs.COMPLAINT,
      },
      { conversations: 1, contact: 5, replies: 4, fallbacks: 1, uncertain: 1, complaints: 1 },
    );
    assert.equal(a.attendance.last30d.contactMessages, 5);
    assert.deepEqual(a.attention, {
      stalledPending: 1,
      unsentReplies: 1,
      openHandoffs: 1,
      tokenInvalid: false,
      tokenExpiringSoon: true,
    });
    assert.deepEqual(a.content, { documents: 1, activeProducts: 1, upcomingAppointments: 1 });

    assert.equal(b.id, companyB.id);
    assert.equal(b.hasPersona, false);
    assert.equal(b.holder, null);
    assert.equal(b.subscription, null);
    assert.equal(b.usage, null);
    assert.equal(b.channel.state, 'NOT_CONNECTED');
    assert.deepEqual(
      {
        contact: b.attendance.last24h.contactMessages,
        replies: b.attendance.last24h.replies,
        fallbacks: b.attendance.last24h.fallbacks,
      },
      { contact: 1, replies: 1, fallbacks: 0 },
    );
    assert.deepEqual(b.attention, {
      stalledPending: 0,
      unsentReplies: 0,
      openHandoffs: 0,
      tokenInvalid: false,
      tokenExpiringSoon: false,
    });
    assert.deepEqual(b.content, { documents: 0, activeProducts: 0, upcomingAppointments: 0 });
  });

  it('o "Testar" do site e a empresa suspensa não entram em "precisa de atenção" (detalhe e filtro da lista)', async () => {
    for (const company of [companyC, companyD]) {
      const detail = (
        await get(`/platform/companies/${company.id}`)
      ).json<PlatformCompanyDetailResponse>();
      assert.equal(detail.attendance.last24h.contactMessages, 1, company.slug);
      assert.equal(detail.attendance.last24h.replies, 1, company.slug);
      assert.equal(detail.attention.stalledPending, 0, company.slug);
      assert.equal(detail.attention.unsentReplies, 0, company.slug);
    }
    for (const attention of ['pending_messages', 'unsent_replies']) {
      const found = (await get(`/platform/companies?attention=${attention}&limit=50`))
        .json<PlatformCompanyListResponse>()
        .items.map((entry) => entry.id);
      assert.ok(found.includes(companyA.id), attention);
      assert.ok(!found.includes(companyC.id), attention);
      assert.ok(!found.includes(companyD.id), attention);
    }
  });

  it('lista de empresas: busca por slug, números por empresa e o filtro de estado', async () => {
    const page = (
      await get(`/platform/companies?q=${companyA.slug}`)
    ).json<PlatformCompanyListResponse>();
    assert.equal(page.items.length, 1);
    const item = page.items[0];
    assert.equal(item?.id, companyA.id);
    assert.equal(item.messages7d, 5);
    assert.equal(item.activeMembers, 1);
    assert.equal(item.plan, 'ESSENTIAL');
    assert.equal(item.access, 'ok');
    assert.equal(item.channelState, 'CONNECTED');
    const listB = (
      await get(`/platform/companies?q=${companyB.slug.toUpperCase()}`)
    ).json<PlatformCompanyListResponse>();
    assert.equal(listB.items[0]?.messages7d, 1);
    assert.equal(listB.items[0].plan, null);

    // Filtro "precisa de atenção" (os critérios do overview): A tem os quatro; B, nenhum; ninguém aqui tem token inválido.
    const ids = async (attention: string): Promise<string[]> =>
      (await get(`/platform/companies?attention=${attention}&limit=50`))
        .json<PlatformCompanyListResponse>()
        .items.map((entry) => entry.id);
    for (const attention of [
      'pending_messages',
      'unsent_replies',
      'token_expiring',
      'open_handoffs',
    ]) {
      const found = await ids(attention);
      assert.ok(found.includes(companyA.id), attention);
      assert.ok(!found.includes(companyB.id), attention);
    }
    const invalid = await ids('token_invalid');
    assert.ok(!invalid.includes(companyA.id) && !invalid.includes(companyB.id));

    // Paginação: duas páginas de 1 sem repetir.
    const first = (await get('/platform/companies?limit=1')).json<PlatformCompanyListResponse>();
    assert.ok(first.nextCursor !== null);
    const second = (
      await get(`/platform/companies?limit=1&cursor=${first.nextCursor}`)
    ).json<PlatformCompanyListResponse>();
    assert.notEqual(second.items[0]?.id, first.items[0]?.id);
    assert.equal((await get('/platform/companies?cursor=lixo')).statusCode, 400);
  });

  it('contas, pedidos, avisos e saúde: só o que o contrato permite', async () => {
    const accounts = (await get('/platform/accounts?limit=50')).json<PlatformAccountListResponse>();
    const mine = accounts.items.find((item) => item.id === accountA);
    assert.ok(mine !== undefined, 'a conta recém-criada está na primeira página');
    assert.equal(mine.emailMasked, 's***@exemplo.test');
    assert.equal(mine.companies, 1);
    assert.equal(mine.hasSubscription, true);

    const orders = (
      await get('/platform/billing/orders?limit=50&status=paid')
    ).json<PlatformOrderListResponse>();
    assert.equal(orders.billingEnabled, true);
    const order = orders.items.find((item) => item.id === orderA);
    assert.deepEqual(
      order && {
        kind: order.kind,
        status: order.status,
        amountCents: order.amountCents,
        captureMethod: order.captureMethod,
        accountId: order.accountId,
      },
      {
        kind: 'NEW',
        status: 'PAID',
        amountCents: 12_345,
        captureMethod: 'pix',
        accountId: accountA,
      },
    );

    const notices = (
      await get('/platform/billing/notices?limit=50&kind=payment_received')
    ).json<PlatformNoticeListResponse>();
    assert.ok(
      notices.items.some((item) => item.accountId === accountA && item.kind === 'PAYMENT_RECEIVED'),
    );

    const health = (await get('/platform/health')).json<PlatformHealthResponse>();
    assert.equal(health.database, 'up');
    assert.equal(health.redis, 'up');
  });

  it('GET /platform/accounts/:accountId (spec 045, D3): só o e-mail mascarado e nada gravado; GET .../email: o completo e um ACCOUNT_EMAIL_VIEWED', async () => {
    const viewed = () =>
      db().platformAuditEvent.count({ where: { adminId, action: 'ACCOUNT_EMAIL_VIEWED' } });
    const before = await viewed();
    const response = await get(`/platform/accounts/${accountA}`);
    assert.equal(response.statusCode, 200);
    const detail = response.json<PlatformAccountDetailResponse>();
    assert.equal(detail.emailMasked, 's***@exemplo.test');
    assert.ok(!response.body.includes(ACCOUNT_EMAIL));
    assert.deepEqual(
      detail.companies.map((company) => [company.id, company.role]),
      [[companyA.id, 'OWNER']],
    );
    assert.equal(detail.subscription?.id, subscriptionA);
    assert.equal(await viewed(), before, 'abrir a conta não grava leitura do e-mail');

    const email = await get(`/platform/accounts/${accountA}/email`);
    assert.equal(email.statusCode, 200);
    assert.deepEqual(email.json<PlatformAccountEmailResponse>(), { email: ACCOUNT_EMAIL });
    const events = await db().platformAuditEvent.findMany({
      where: { adminId, action: 'ACCOUNT_EMAIL_VIEWED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(events.length, before + 1);
    assert.equal(events[0]?.subjectAccountId, accountA);
    assert.equal(events[0].subjectCompanyId, null);
    assert.equal((await get(`/platform/accounts/${randomUUID()}`)).statusCode, 404);
    assert.equal((await get(`/platform/accounts/${randomUUID()}/email`)).statusCode, 404);
    assert.equal(await viewed(), before + 1, '404 não grava');
  });

  it('pessoas e dono (spec 045, E1): o detalhe de A lista só as pessoas de A, dono primeiro e mascarado; a lista traz o dono e owners = 0 sem dono ativo', async () => {
    const now = new Date();
    const lower = tag.toLowerCase();
    // Em A, além do dono (conta A): uma atendente mais antiga que o dono, com conta não confirmada, e um
    // administrador desativado, vínculo antigo da CLI (sem conta). Dois convites pendentes, um já vencido.
    const agentAccount = await db().account.create({
      data: { email: `zeca-${lower}@exemplo.test`, passwordHash: 'x' },
    });
    createdAccounts.push(agentAccount.id);
    const agent = await db().membership.create({
      data: {
        companyId: companyA.id,
        email: `zeca-${lower}@exemplo.test`,
        passwordHash: 'x',
        role: 'AGENT',
        accountId: agentAccount.id,
        createdAt: new Date(now.getTime() - 2 * DAY),
      },
    });
    const legacy = await db().membership.create({
      data: {
        companyId: companyA.id,
        email: `velho-${lower}@exemplo.test`,
        passwordHash: 'x',
        role: 'ADMIN',
        status: 'DISABLED',
      },
    });
    const ownerA = await db().membership.findFirst({
      where: { companyId: companyA.id, role: 'OWNER' },
      select: { id: true },
    });
    assert.ok(ownerA !== null);
    for (const [email, expiresAt] of [
      [`convite-${lower}@exemplo.test`, new Date(now.getTime() + DAY)],
      [`vencido-${lower}@exemplo.test`, new Date(now.getTime() - HOUR)],
    ] as const) {
      await db().companyInvitation.create({
        data: {
          companyId: companyA.id,
          email,
          role: 'AGENT',
          tokenHash: randomBytes(32).toString('hex'),
          invitedByMembershipId: ownerA.id,
          expiresAt,
          lastSentAt: now,
        },
      });
    }
    // Empresa E: o único dono tem a conta DESATIVADA (não conta como dono ativo).
    const companyE = await tenants.createCompany('plat-e');
    const disabledAccount = await db().account.create({
      data: { email: `dono-off-${lower}@exemplo.test`, passwordHash: 'x', status: 'DISABLED' },
    });
    createdAccounts.push(disabledAccount.id);
    await db().membership.create({
      data: {
        companyId: companyE.id,
        email: `dono-off-${lower}@exemplo.test`,
        passwordHash: 'x',
        role: 'OWNER',
        accountId: disabledAccount.id,
      },
    });

    const a = (
      await get(`/platform/companies/${companyA.id}`)
    ).json<PlatformCompanyDetailResponse>();
    assert.deepEqual(
      a.people.map((person) => [
        person.membershipId,
        person.role,
        person.status,
        person.emailMasked,
        person.accountId,
        person.account,
      ]),
      [
        [
          ownerA.id,
          'OWNER',
          'ACTIVE',
          's***@exemplo.test',
          accountA,
          { status: 'ACTIVE', verified: true },
        ],
        [legacy.id, 'ADMIN', 'DISABLED', 'v***@exemplo.test', null, null],
        [
          agent.id,
          'AGENT',
          'ACTIVE',
          'z***@exemplo.test',
          agentAccount.id,
          { status: 'ACTIVE', verified: false },
        ],
      ],
    );
    assert.equal(a.peopleTotal, 3);
    assert.equal(a.owners, 1);
    assert.deepEqual(a.owner, { accountId: accountA, emailMasked: 's***@exemplo.test' });
    assert.equal(a.pendingInvitations, 1, 'o convite vencido não conta');
    assert.equal(a.holder?.accountId, accountA, 'o titular da assinatura continua');

    // B não vê ninguém de A (e vice-versa): o dono de B é o vínculo antigo sem conta, sem assinatura.
    const b = (
      await get(`/platform/companies/${companyB.id}`)
    ).json<PlatformCompanyDetailResponse>();
    assert.deepEqual(
      b.people.map((person) => [person.role, person.emailMasked, person.accountId]),
      [['OWNER', 'b***@exemplo.test', null]],
    );
    assert.equal(b.holder, null, 'sem assinatura...');
    assert.equal(b.owners, 1, '...o dono aparece pelos vínculos');
    assert.deepEqual(b.owner, { accountId: null, emailMasked: 'b***@exemplo.test' });
    assert.equal(b.pendingInvitations, 0);
    const aIds = new Set(a.people.map((person) => person.membershipId));
    assert.ok(b.people.every((person) => !aIds.has(person.membershipId)));

    const e = (
      await get(`/platform/companies/${companyE.id}`)
    ).json<PlatformCompanyDetailResponse>();
    assert.equal(e.owners, 0);
    assert.equal(e.owner, null, 'conta desativada não é dono ativo');
    assert.deepEqual(
      e.people.map((person) => [person.role, person.account?.status]),
      [['OWNER', 'DISABLED']],
    );

    const list = async (q: string) =>
      (await get(`/platform/companies?q=${q}`)).json<PlatformCompanyListResponse>().items[0];
    const listA = await list(companyA.slug);
    assert.deepEqual(listA?.owner, { accountId: accountA, emailMasked: 's***@exemplo.test' });
    assert.equal(listA.owners, 1);
    const listB = await list(companyB.slug);
    assert.deepEqual(listB?.owner, { accountId: null, emailMasked: 'b***@exemplo.test' });
    assert.equal(listB.owners, 1);
    for (const company of [companyC, companyE]) {
      const item = await list(company.slug);
      assert.equal(item?.owner, null, company.slug);
      assert.equal(item.owners, 0, company.slug);
    }
    // Ler pessoas e dono não grava nada na trilha da plataforma.
    assert.equal(
      await db().platformAuditEvent.count({
        where: { adminId, subjectCompanyId: { in: [companyA.id, companyB.id, companyE.id] } },
      }),
      0,
    );
  });

  it('suspender e reativar: 204, estado e evento com o motivo na mesma transação; repetir e concorrer não duplicam', async () => {
    const events = (action: 'COMPANY_SUSPENDED' | 'COMPANY_REACTIVATED') =>
      db().platformAuditEvent.findMany({
        where: { adminId, action, subjectCompanyId: companyB.id },
      });
    const status = async () =>
      (await db().company.findFirst({ where: { id: companyB.id }, select: { status: true } }))
        ?.status;

    assert.equal(
      (await post(`/platform/companies/${companyB.id}/suspend`, { reason: 'ABUSE' })).statusCode,
      204,
    );
    assert.equal(await status(), 'SUSPENDED');
    assert.equal(
      (await post(`/platform/companies/${companyB.id}/suspend`, { reason: 'OTHER' })).statusCode,
      204,
    );
    const suspended = await events('COMPANY_SUSPENDED');
    assert.equal(suspended.length, 1);
    assert.equal(suspended[0]?.reason, 'ABUSE');
    const list = (
      await get('/platform/companies?status=suspended&limit=50')
    ).json<PlatformCompanyListResponse>();
    assert.ok(list.items.some((item) => item.id === companyB.id));

    const results = await Promise.all([
      post(`/platform/companies/${companyB.id}/reactivate`, { reason: 'OWNER_REQUEST' }),
      post(`/platform/companies/${companyB.id}/reactivate`, { reason: 'OWNER_REQUEST' }),
    ]);
    assert.deepEqual(
      results.map((response) => response.statusCode),
      [204, 204],
    );
    assert.equal(await status(), 'ACTIVE');
    assert.equal((await events('COMPANY_REACTIVATED')).length, 1);

    assert.equal(
      (await post(`/platform/companies/${companyB.id}/suspend`, { reason: 'CALOTE' })).statusCode,
      400,
    );
    assert.equal(
      (await post(`/platform/companies/${randomUUID()}/suspend`, { reason: 'OTHER' })).statusCode,
      404,
    );
    assert.equal(await status(), 'ACTIVE');
  });

  it('a sessão do admin não lê conversas nem mensagens: cookie sozinho 401, Bearer de plataforma 403', async () => {
    const platformBearer = bearer((await testAuth.platformToken()).accessToken);
    for (const url of [
      `/admin/companies/${companyA.id}/conversations`,
      `/admin/companies/${companyA.id}/conversations/${conversationA}/messages`,
    ]) {
      assert.equal((await get(url, { cookie })).statusCode, 401, url);
      assert.equal((await get(url, platformBearer)).statusCode, 403, url);
    }
  });

  it('privacidade: nenhum sentinela em resposta de /platform/*, log nem /metrics; o e-mail completo só sai em /email', async () => {
    assert.ok(platformBodies.length >= 15, 'as rotas foram exercitadas antes desta varredura');
    const metricsBody = (
      await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      })
    ).body;
    const raw = logs.raw();
    for (const sentinel of CONTENT_SENTINELS) {
      for (const { url, body } of platformBodies) {
        assert.ok(!body.includes(sentinel), `${sentinel} em ${url}`);
      }
      assert.ok(!raw.includes(sentinel), `${sentinel} no log`);
      assert.ok(!metricsBody.includes(sentinel), `${sentinel} no /metrics`);
    }
    const withEmail = platformBodies
      .filter(({ body }) => body.includes(ACCOUNT_EMAIL))
      .map(({ url }) => url);
    // Spec 045, D3: o e-mail completo sai só da rota auditada, nunca do detalhe da conta nem da empresa.
    assert.deepEqual([...new Set(withEmail)], [`/platform/accounts/${accountA}/email`]);
    assert.ok(!raw.includes(ACCOUNT_EMAIL), 'e-mail no log');
    assert.ok(!metricsBody.includes(ACCOUNT_EMAIL));
    // As pessoas (spec 045, E1) aparecem só mascaradas: nenhum e-mail completo de vínculo ou de conta.
    const lower = tag.toLowerCase();
    for (const local of ['zeca', 'velho', 'convite', 'vencido', 'dono-off', 'b']) {
      const full = `${local}-${lower}@exemplo.test`;
      for (const { url, body } of platformBodies) {
        assert.ok(!body.includes(full), `${full} em ${url}`);
      }
      assert.ok(!raw.includes(full), `${full} no log`);
      assert.ok(!metricsBody.includes(full), `${full} no /metrics`);
    }
  });
});
