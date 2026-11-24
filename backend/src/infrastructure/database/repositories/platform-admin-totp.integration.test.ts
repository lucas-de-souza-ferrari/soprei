import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccountId, type Company, type PlatformAdmin } from '../../../domain/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { MODEL_SCOPES } from '../extensions/tenant-scope.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaPlatformAdminRepository } from './platform-admin.repository.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;

let database: Database;
let tenants: TestTenants;
let admins: PrismaPlatformAdminRepository;
let audit: PrismaPlatformAuditRepository;
let company: Company;
const createdAdmins: string[] = [];
const createdAccounts: string[] = [];

async function newAdmin(): Promise<PlatformAdmin> {
  const admin = await admins.create({ email: email('plat'), passwordHash: HASH });
  createdAdmins.push(admin.id);
  return admin;
}

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  admins = new PrismaPlatformAdminRepository(database.prisma);
  audit = new PrismaPlatformAuditRepository(database.prisma);
  company = await tenants.createCompany('plat-audit');
});

after(async () => {
  try {
    // Só o que este arquivo criou: a trilha primeiro (FK Restrict para o admin e a empresa).
    await database.prisma.platformAuditEvent.deleteMany({
      where: { adminId: { in: createdAdmins } },
    });
    await database.prisma.platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
    await database.prisma.account.deleteMany({ where: { id: { in: createdAccounts } } });
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

describe('segundo fator do PlatformAdmin no Postgres (spec 044, E1)', () => {
  it('grava, lê e apaga o segredo cifrado; a credencial do login traz o texto cifrado', async () => {
    const admin = await newAdmin();
    assert.equal(await admins.findTotpSecret(admin.id), null);
    await admins.setTotpSecret(admin.id, 'v1.t1.iv.tag.corpo');
    assert.equal(await admins.findTotpSecret(admin.id), 'v1.t1.iv.tag.corpo');
    const credentials = await admins.findCredentialsByEmail(admin.email);
    assert.equal(credentials?.totpSecretCiphertext, 'v1.t1.iv.tag.corpo');
    await admins.setTotpSecret(admin.id, null);
    assert.equal(await admins.findTotpSecret(admin.id), null);
  });

  it('claimTotpStep: sob concorrência o mesmo passo entra uma vez; passo anterior nunca; sem fator, nunca', async () => {
    const admin = await newAdmin();
    assert.equal(await admins.claimTotpStep(admin.id, 100), false, 'sem fator');
    await admins.setTotpSecret(admin.id, 'v1.t1.iv.tag.corpo');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => admins.claimTotpStep(admin.id, 100)),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await admins.claimTotpStep(admin.id, 99), false);
    assert.equal(await admins.claimTotpStep(admin.id, 101), true);
    // Recadastrar zera o último passo.
    await admins.setTotpSecret(admin.id, 'v1.t1.iv.tag.outro');
    assert.equal(await admins.claimTotpStep(admin.id, 50), true);
  });
});

describe('PlatformAuditEvent (spec 044, model global)', () => {
  it('está classificado como global e o repositório só cria e lista', () => {
    assert.equal(MODEL_SCOPES.PlatformAuditEvent, 'global');
    const methods = Object.getOwnPropertyNames(PrismaPlatformAuditRepository.prototype).sort();
    assert.deepEqual(methods, ['constructor', 'create', 'list']);
  });

  it('cria e lista do mais novo ao mais antigo, com os sujeitos e o motivo', async () => {
    const admin = await newAdmin();
    const login = await audit.create({ adminId: admin.id, action: 'PLATFORM_LOGIN' });
    const suspended = await audit.create({
      adminId: admin.id,
      action: 'COMPANY_SUSPENDED',
      subjectCompanyId: company.id,
      reason: 'PAYMENT',
    });
    assert.equal(login.subjectCompanyId, null);
    assert.equal(suspended.subjectCompanyId, company.id);
    assert.equal(suspended.reason, 'PAYMENT');
    const page = await audit.list({ limit: 50 });
    const mine = page.items.filter((event) => event.adminId === admin.id).map((event) => event.id);
    assert.deepEqual(mine, [suspended.id, login.id]);
  });

  it('apagar uma conta (expurgo da spec 021) não é barrado pela trilha: o sujeito vira nulo', async () => {
    const admin = await newAdmin();
    const account = await database.prisma.account.create({
      data: { email: email('conta'), passwordHash: HASH },
    });
    createdAccounts.push(account.id);
    const viewed = await audit.create({
      adminId: admin.id,
      action: 'ACCOUNT_EMAIL_VIEWED',
      subjectAccountId: AccountId.parse(account.id),
    });
    await database.prisma.account.deleteMany({ where: { id: account.id } });
    const row = await database.prisma.platformAuditEvent.findFirst({ where: { id: viewed.id } });
    assert.ok(row !== null);
    assert.equal(row.subjectAccountId, null);
    assert.equal(row.action, 'ACCOUNT_EMAIL_VIEWED');
  });

  it('admin com trilha não pode ser apagado (FK Restrict)', async () => {
    const admin = await newAdmin();
    await audit.create({ adminId: admin.id, action: 'PLATFORM_LOGIN' });
    await assert.rejects(database.prisma.platformAdmin.deleteMany({ where: { id: admin.id } }));
  });
});
