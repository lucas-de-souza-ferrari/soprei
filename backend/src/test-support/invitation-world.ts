import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccountService } from '../application/auth/account.service.js';
import { deriveLoginLockSecret } from '../application/auth/auth.service.js';
import { AttendanceService } from '../application/attendance/attendance.service.js';
import { CompanyService } from '../application/companies/company.service.js';
import {
  InvitationService,
  type InvitationServiceDeps,
} from '../application/invitations/invitation.service.js';
import type {
  CompanyInvitationMail,
  InvitationMailer,
} from '../application/ports/account-session.js';
import type { InvitationQuotaStore } from '../application/ports/invitation-quota.js';
import type { InvitationUnitOfWork } from '../application/ports/invitation-unit-of-work.js';
import type { MembershipRole } from '../domain/index.js';
import { createAuthRedis } from '../infrastructure/auth/auth-redis.js';
import { versionedAuthPrefix } from '../infrastructure/auth/auth-version.js';
import { createAuthComponents } from '../infrastructure/auth/create-auth.js';
import { RedisAccountSessionStore } from '../infrastructure/auth/redis-account-session-store.js';
import { RedisInvitationQuotaStore } from '../infrastructure/auth/redis-invitation-quota.js';
import { ScryptPasswordHasher } from '../infrastructure/auth/scrypt-password-hasher.js';
import {
  createDatabase,
  PrismaAccountRepository,
  PrismaCompanyInvitationRepository,
  PrismaAttendanceUnitOfWork,
  PrismaCompanyRepository,
  PrismaConversationRepository,
  PrismaInvitationUnitOfWork,
  PrismaMessageRepository,
} from '../infrastructure/database/index.js';
import { MockLlmProvider } from '../infrastructure/external-apis/llm/mock-llm.provider.js';
import { buildServer } from '../infrastructure/http/server.js';
import { createMetrics } from '../infrastructure/metrics/index.js';
import { ServiceUnavailableError } from '../shared/errors/index.js';
import { Result } from '../shared/types/index.js';
import { loadIntegrationConfig } from './integration-env.js';
import { captureLogs } from './log-capture.js';
import { noResetMail } from './no-reset-mail.js';
import { TestKeyspace } from './test-keyspace.js';
import { TestTenants } from './tenant-fixtures.js';

export const INVITE_ORIGIN = 'http://localhost:5174';
export const CSRF = { origin: INVITE_ORIGIN, 'x-soprei-app': 'web' } as const;
export const PASSWORD = 'Secret1-forte';

/** `hash` do scrypt de custo baixo, com contagem de chamadas (prova que o hash só vem depois da pré-checagem). */
export class CountingHasher extends ScryptPasswordHasher {
  hashCalls = 0;
  override hash(...args: Parameters<ScryptPasswordHasher['hash']>): Promise<string> {
    this.hashCalls += 1;
    return super.hash(...args);
  }
}

export interface Person {
  readonly email: string;
  readonly cookie: string;
  readonly accountId: string;
}

export interface SentMail {
  readonly email: string;
  readonly mail: CompanyInvitationMail;
}

/** Corpo de erro sem o `requestId` (muda a cada resposta). */
export function errorOf(response: LightMyRequestResponse): { code: string; message: string } {
  const { error } = response.json<{ error: { code: string; message: string } }>();
  return { code: error.code, message: error.message };
}

export function tokenOf(mail: SentMail | undefined): string {
  assert.ok(mail, 'um e-mail de convite foi enviado');
  const [, token] = mail.mail.link.split('#t=');
  assert.ok(token, 'o link tem o token no fragmento');
  return token;
}

/**
 * Mundo de teste da spec 025: servidor real (Fastify) com Postgres e Redis reais (`soprei_test` e
 * `/15`), contas e sessões de verdade, e-mail **falso** (nenhum SMTP), relógio deslocável e a cota
 * de envio no Redis real com prefixo único. Cada arquivo de teste cria o seu.
 */
export async function createInvitationWorld(label: string) {
  const config = loadIntegrationConfig();
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const tenants = new TestTenants(db.prisma);
  const keys = new TestKeyspace();
  const prefix = keys.scopedPrefix(label);
  const redis = createAuthRedis(config, logs.logger);
  assert.ok(await redis.waitUntilReady(5_000));
  const passwords = new CountingHasher({ cost: { N: 1024, r: 8, p: 1 } });
  const metrics = createMetrics();
  const verification = new Map<string, string>();
  const emails: string[] = [];
  const sent: SentMail[] = [];
  const control = {
    /** Desloca o relógio dos serviços (convites vencidos e intervalo de reenvio). */
    offsetMs: 0,
    mailerFails: false,
    /** Segura os envios até a promessa resolver (prova que o `drain` espera). */
    mailerGate: undefined as Promise<void> | undefined,
    quotaDown: false,
    accountLookups: 0,
  };
  const now = (): Date => new Date(Date.now() + control.offsetMs);

  const auth = createAuthComponents({
    config: { ...config, ACCOUNTS_ENABLED: true, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: db.prisma,
    authRedis: redis,
    metrics,
    hasher: passwords,
  });
  const sessionPrefix = versionedAuthPrefix(prefix, true);
  const accountRepository = new PrismaAccountRepository(db.prisma);
  const accounts = new AccountService({
    accounts: accountRepository,
    passwords,
    sessions: new RedisAccountSessionStore(redis.client, sessionPrefix),
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    mailer: {
      ...noResetMail,
      sendVerification: (email, code) => {
        verification.set(email, code);
        return Promise.resolve();
      },
    },
  });
  const mailer: InvitationMailer = {
    sendCompanyInvitation: async (email, mail) => {
      if (control.mailerGate !== undefined) await control.mailerGate;
      if (control.mailerFails) throw new Error(`falha de SMTP para ${email}`);
      sent.push({ email, mail });
    },
  };
  const quotaStore = new RedisInvitationQuotaStore(redis.client, sessionPrefix);
  const quota: InvitationQuotaStore = {
    ping: () =>
      control.quotaDown
        ? Promise.reject(new ServiceUnavailableError('Cotas de convite indisponíveis'))
        : quotaStore.ping(),
    take: (recipient, account) => quotaStore.take(recipient, account),
  };
  const companyRepository = new PrismaCompanyRepository(db.prisma);
  const unitOfWork = new PrismaInvitationUnitOfWork(db.prisma);

  function buildInvitations(overrides: Partial<InvitationServiceDeps> = {}): InvitationService {
    return new InvitationService({
      invitations: new PrismaCompanyInvitationRepository(db.prisma),
      companies: companyRepository,
      // O `create` nunca deve consultar contas: a sonda conta as consultas.
      accounts: {
        findByEmail: (email) => {
          control.accountLookups += 1;
          return accountRepository.findByEmail(email);
        },
      },
      unitOfWork,
      hasher: passwords,
      mailer,
      quota,
      logger: logs.logger,
      metrics,
      loginSecret: deriveLoginLockSecret(config.JWT_SECRET),
      appOrigin: INVITE_ORIGIN,
      now,
      ...overrides,
    });
  }
  const invitations = buildInvitations();

  const app: FastifyInstance = buildServer({
    logger: logs.logger,
    metrics,
    metricsToken: 'm'.repeat(32),
    readiness: { database: () => db.check(), redis: () => Promise.resolve(Result.ok(undefined)) },
    auth: auth.service,
    membershipAdmin: auth.membershipAdmin,
    admin: {
      companies: new CompanyService(companyRepository),
      // Rotas de conversa (conversation:read) para provar o que cada papel alcança depois do aceite.
      attendance: new AttendanceService({
        companies: companyRepository,
        conversations: new PrismaConversationRepository(db.prisma),
        messages: new PrismaMessageRepository(db.prisma),
        unitOfWork: new PrismaAttendanceUnitOfWork(db.prisma),
        llm: new MockLlmProvider(),
        logger: logs.logger,
        metrics,
        options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000 },
      }),
    },
    accounts: { service: accounts, origin: INVITE_ORIGIN, secure: false, invitations },
  });

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: { cookie?: string; payload?: object; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(method === 'GET' ? {} : CSRF),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...options.headers,
      },
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });

  async function signUp(name: string, password = PASSWORD): Promise<Person> {
    const email = `${name}-${randomUUID()}@invites.test`;
    emails.push(email);
    assert.equal(
      (await request('POST', '/auth/register', { payload: { email, password } })).statusCode,
      202,
    );
    await accounts.drain();
    const code = verification.get(email);
    assert.match(code ?? '', /^[0-9]{6}$/);
    assert.equal(
      (await request('POST', '/auth/verify-email', { payload: { email, password, code } }))
        .statusCode,
      204,
    );
    return login(email, password);
  }

  async function login(email: string, password = PASSWORD): Promise<Person> {
    const response = await request('POST', '/auth/login', { payload: { email, password } });
    assert.equal(response.statusCode, 204);
    const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
    const account = await accountRepository.findByEmail(email);
    assert.ok(account);
    return { email, cookie, accountId: account.id };
  }

  async function createCompany(person: Person, name: string): Promise<string> {
    const response = await request('POST', '/account/companies', {
      cookie: person.cookie,
      payload: { name },
    });
    assert.equal(response.statusCode, 201);
    const { companyId } = response.json<{ companyId: string }>();
    tenants.track(companyId);
    assert.equal(
      (
        await request('POST', `/account/companies/${companyId}/select`, {
          cookie: person.cookie,
          payload: {},
        })
      ).statusCode,
      204,
    );
    return companyId;
  }

  /** Seleciona a empresa na sessão da pessoa (a ponte do cookie usa só a selecionada). */
  async function select(person: Person, companyId: string): Promise<void> {
    assert.equal(
      (
        await request('POST', `/account/companies/${companyId}/select`, {
          cookie: person.cookie,
          payload: {},
        })
      ).statusCode,
      204,
    );
  }

  /** Pessoa nova e confirmada, dona de uma empresa nova já selecionada (cota por conta própria). */
  async function setup(companyName: string): Promise<{ owner: Person; company: string }> {
    const owner = await signUp('dono');
    return { owner, company: await createCompany(owner, companyName) };
  }

  /** Vínculo direto no banco (atalho de teste) e seleção da empresa na sessão da pessoa. */
  async function join(person: Person, companyId: string, role: MembershipRole): Promise<string> {
    const row = await db.prisma.membership.create({
      data: {
        companyId,
        accountId: person.accountId,
        email: person.email,
        passwordHash: 'account-managed',
        role,
      },
    });
    assert.equal(
      (
        await request('POST', `/account/companies/${companyId}/select`, {
          cookie: person.cookie,
          payload: {},
        })
      ).statusCode,
      204,
    );
    return row.id;
  }

  /** E-mail novo (sem conta) rastreado para limpeza. */
  function freshEmail(name: string): string {
    const email = `${name}-${randomUUID()}@convidado.test`;
    emails.push(email);
    return email;
  }

  const invite = (person: Person, companyId: string, email: string, role = 'AGENT') =>
    request('POST', `/admin/companies/${companyId}/invitations`, {
      cookie: person.cookie,
      payload: { email, role },
    });

  /** Cria um convite (201) e devolve o item e o token do e-mail enviado. */
  async function inviteOk(person: Person, companyId: string, email: string, role = 'AGENT') {
    const before = sent.length;
    const response = await invite(person, companyId, email, role);
    assert.equal(response.statusCode, 201, response.body);
    await invitations.drain();
    const item = response.json<{ id: string; email: string; role: string; sendCount: number }>();
    const mail = sent.slice(before).find((entry) => entry.email === email);
    return { item, token: mail === undefined ? undefined : tokenOf(mail), mail };
  }

  async function close(): Promise<void> {
    try {
      await app.close();
      await tenants.cleanup();
      await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
      await keys.cleanup(redis.client);
    } finally {
      await redis.close();
      await db.close();
    }
  }

  return {
    config,
    logs,
    db,
    tenants,
    redis,
    app,
    accounts,
    invitations,
    buildInvitations,
    passwords,
    metrics,
    control,
    sent,
    request,
    signUp,
    login,
    createCompany,
    select,
    setup,
    join,
    freshEmail,
    invite,
    inviteOk,
    close,
    accountRepository,
    unitOfWork: unitOfWork as InvitationUnitOfWork,
  };
}

export type InvitationWorld = Awaited<ReturnType<typeof createInvitationWorld>>;
