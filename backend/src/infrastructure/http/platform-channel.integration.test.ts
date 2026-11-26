import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import { ChannelConnectionService } from '../../application/channel/channel-connection.service.js';
import type { ChannelUnitOfWork } from '../../application/ports/channel-unit-of-work.js';
import { PlatformCompanyService } from '../../application/platform/platform-company.service.js';
import { type Company, PlatformAdminId } from '../../domain/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { Result, SecretString } from '../../shared/types/index.js';
import {
  buildChannelCredentials,
  testCredentialCipher,
} from '../../test-support/channel-credentials.js';
import { FakeGraphApi, FULL_SCOPES, graphError } from '../../test-support/fake-graph-api.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import {
  createDatabase,
  type Database,
  PrismaChannelUnitOfWork,
  PrismaCompanyRepository,
  PrismaPlatformCompanyUnitOfWork,
} from '../database/index.js';
import { WhatsappGraphAdminClient } from '../external-apis/whatsapp/whatsapp-graph-admin.client.js';
import { createMetrics } from '../metrics/index.js';

// Spec 045, E5: o admin da plataforma desconecta o WhatsApp de uma empresa com o Postgres real (soprei_test)
// e a Graph API falsa (nenhuma chamada real à Meta). O código do autenticador é um dublê que aceita só CODE.

const config = loadIntegrationConfig();
const APP_ID = '1234567890123';
const CODE = '123456';
const graph = new FakeGraphApi();
const logs = captureLogs();
const metrics = createMetrics();
let database: Database;
let tenants: TestTenants;
let admin: PlatformIdentity;
const createdAdmins: string[] = [];

const db = () => database.prisma;
const digits = (): string => `9${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;

/** Uma cifra só: a que grava o token em `connected()` precisa ser a que o serviço usa para decifrá-lo. */
const cipher = testCredentialCipher();

function channelService(unitOfWork?: ChannelUnitOfWork) {
  const stack = buildChannelCredentials(database.prisma, { cipher });
  const service = new ChannelConnectionService({
    companies: new PrismaCompanyRepository(database.prisma),
    connections: stack.connections,
    unitOfWork: unitOfWork ?? new PrismaChannelUnitOfWork(database.prisma),
    cipher: stack.cipher,
    provisioner: new WhatsappGraphAdminClient({
      baseUrl: graph.baseUrl,
      graphApiVersion: 'v26.0',
      appId: APP_ID,
      appSecret: `app-secret-${randomUUID()}`,
      timeoutMs: 400,
    }),
    appId: APP_ID,
    logger: logs.logger,
    metrics,
  });
  return { service, cipher: stack.cipher };
}

function platform(channel?: ChannelConnectionService) {
  return new PlatformCompanyService({
    companies: new PrismaPlatformCompanyUnitOfWork(database.prisma),
    confirmer: {
      confirmPlatformCode: (_id, code) =>
        Promise.resolve(
          code === CODE ? Result.ok(undefined) : Result.err({ reason: 'invalid_credentials' }),
        ),
    },
    bearerSessions: { revokeAllSessions: () => Promise.resolve() },
    ...(channel === undefined ? {} : { channel }),
    logger: logs.logger,
    metrics,
  });
}

/** Empresa conectada: número, conexão com o token e o PIN cifrados, e a WABA assinada na Graph falsa. */
async function connected(label: string) {
  const number = digits();
  const company = await tenants.createCompany(label, number);
  const token = `EAAG-token-${randomUUID()}`;
  const pin = String(100_000 + Math.floor(Math.random() * 899_999));
  const waba = `7${randomBytes(6).readUIntBE(0, 6).toString().padStart(14, '0')}`;
  graph.addWaba(waba, [number]);
  graph.addToken(token, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [waba] });
  graph.subscribed.add(waba);
  await db().channelConnection.create({
    data: {
      companyId: company.id,
      wabaId: waba,
      tokenCiphertext: cipher.encrypt(company.id, new SecretString(token)),
      registrationPinCiphertext: cipher.encrypt(company.id, new SecretString(pin)),
    },
  });
  return { company, number, token, pin, waba };
}

async function platformEvents(company: Company) {
  return db().platformAuditEvent.findMany({
    where: { subjectCompanyId: company.id },
    select: { action: true, reason: true, adminId: true },
  });
}

before(async () => {
  await graph.start();
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  const row = await db().platformAdmin.create({
    data: { email: `adm-e5-${randomUUID()}@exemplo.test`, passwordHash: 'x' },
  });
  createdAdmins.push(row.id);
  admin = { kind: 'platform', adminId: PlatformAdminId.parse(row.id), sessionId: randomUUID() };
});

afterEach(() => {
  graph.reset();
});

after(async () => {
  try {
    await db().platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
    await tenants.cleanup();
    await db().platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
  } finally {
    await database.close();
    await graph.stop();
  }
});

describe('desconectar o WhatsApp pela plataforma (spec 045, E5)', () => {
  it('conexão e número removidos, trilha da plataforma, nada na trilha da empresa, WABA desassinada; o número deixa de levar à empresa', async () => {
    const { company, number, waba } = await connected('pe5-a');
    const { service } = channelService();
    assert.equal(await platform(service).disconnectChannel(admin, company.id, 'ABUSE', CODE), true);
    assert.equal(await db().channelConnection.count({ where: { companyId: company.id } }), 0);
    const row = await db().company.findFirst({
      where: { id: company.id },
      select: { whatsappPhoneNumberId: true },
    });
    assert.equal(row?.whatsappPhoneNumberId, null);
    // O webhook acha a empresa por este número: sem ela, a mensagem vira unknown_number.
    assert.equal(await new PrismaCompanyRepository(db()).findByWhatsappPhoneNumberId(number), null);
    assert.deepEqual(await platformEvents(company), [
      { action: 'CHANNEL_DISCONNECTED_BY_PLATFORM', reason: 'ABUSE', adminId: admin.adminId },
    ]);
    assert.equal(await db().auditEvent.count({ where: { companyId: company.id } }), 0);
    assert.ok(!graph.subscribed.has(waba));
    // Repetir: nada a desconectar, 204 sem evento.
    assert.equal(
      await platform(service).disconnectChannel(admin, company.id, 'ABUSE', CODE),
      false,
    );
    assert.equal((await platformEvents(company)).length, 1);
  });

  it('empresa LEGACY (número sem conexão): só limpa o número, liberando-o', async () => {
    const number = digits();
    const company = await tenants.createCompany('pe5-legacy', number);
    const { service } = channelService();
    assert.equal(await platform(service).disconnectChannel(admin, company.id, 'OTHER', CODE), true);
    const row = await db().company.findFirst({
      where: { id: company.id },
      select: { whatsappPhoneNumberId: true },
    });
    assert.equal(row?.whatsappPhoneNumberId, null);
    assert.equal((await platformEvents(company))[0]?.action, 'CHANNEL_DISCONNECTED_BY_PLATFORM');
  });

  it('a desassinatura que falha na Meta não desfaz nada', async () => {
    const { company, waba } = await connected('pe5-meta');
    graph.failOperation('unsubscribe', graphError(500, 1));
    const { service } = channelService();
    assert.equal(await platform(service).disconnectChannel(admin, company.id, 'OTHER', CODE), true);
    assert.equal(await db().channelConnection.count({ where: { companyId: company.id } }), 0);
    assert.ok(graph.subscribed.has(waba), 'a WABA continua assinada (falha em silêncio, só log)');
    assert.equal((await platformEvents(company)).length, 1);
  });

  it('código errado, empresa removida ou canal desligado: nada muda', async () => {
    const { company } = await connected('pe5-recusa');
    const { service } = channelService();
    await assert.rejects(platform(service).disconnectChannel(admin, company.id, 'OTHER', '000000'));
    await assert.rejects(
      platform().disconnectChannel(admin, company.id, 'OTHER', CODE),
      NotFoundError,
    );
    const removed = await connected('pe5-removida');
    await db().company.updateMany({
      where: { id: removed.company.id },
      data: { deletedAt: new Date() },
    });
    await assert.rejects(
      platform(service).disconnectChannel(admin, removed.company.id, 'OTHER', CODE),
      NotFoundError,
    );
    assert.equal(await db().channelConnection.count({ where: { companyId: company.id } }), 1);
    assert.deepEqual(await platformEvents(company), []);
  });

  it('trilha que falha: a conexão e o número continuam (rollback real)', async () => {
    const { company } = await connected('pe5-trilha');
    const real = new PrismaChannelUnitOfWork(database.prisma);
    const broken: ChannelUnitOfWork = {
      run: (fn) =>
        real.run((tx) =>
          fn({ ...tx, platformAudit: () => Promise.reject(new Error('trilha indisponível')) }),
        ),
    };
    const { service } = channelService(broken);
    await assert.rejects(platform(service).disconnectChannel(admin, company.id, 'OTHER', CODE));
    assert.equal(await db().channelConnection.count({ where: { companyId: company.id } }), 1);
    const row = await db().company.findFirst({
      where: { id: company.id },
      select: { whatsappPhoneNumberId: true },
    });
    assert.notEqual(row?.whatsappPhoneNumberId, null);
  });

  it('privacidade: nenhum log ou métrica traz token, PIN ou a WABA inteira', async () => {
    const { company, token, pin, waba } = await connected('pe5-priv');
    const { service } = channelService();
    await platform(service).disconnectChannel(admin, company.id, 'OTHER', CODE);
    const raw = logs.raw();
    const body = await metrics.registry.metrics();
    for (const secret of [token, pin, waba]) {
      assert.ok(!logContains(raw, secret), 'no log');
      assert.ok(!logContains(body, secret), 'na métrica');
    }
    assert.match(body, /action="channel_disconnected_by_platform"/);
  });
});
