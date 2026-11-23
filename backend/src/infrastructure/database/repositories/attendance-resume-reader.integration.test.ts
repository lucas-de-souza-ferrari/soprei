import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  ResumeScanOptions,
  ResumeTarget,
} from '../../../application/ports/attendance-resume.js';
import { SITE_TEST_CONTACT_REF } from '../../../application/attendance/contact-label.js';
import type { Company } from '../../../domain/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaResumeTargetReader } from './attendance-resume-reader.js';

// Spec 035: quem ficou sem resposta no canal, contra o Postgres real (soprei_test). Relógio fixo: as
// mensagens são gravadas com `createdAt` relativo a `NOW`, então o teste nunca vence.
const config = loadIntegrationConfig();
const NOW = new Date('2026-11-23T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (msAgo: number): Date => new Date(NOW.getTime() - msAgo);

let database: Database;
let tenants: TestTenants;
let reader: PrismaResumeTargetReader;

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  reader = new PrismaResumeTargetReader(database.prisma);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

const db = () => database.prisma;
const phoneNumber = (): string =>
  `9${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;
const contact = (): string => `5511${randomBytes(4).readUInt32BE(0).toString().padStart(9, '0')}`;

const OPTIONS: Omit<ResumeScanOptions, 'afterCompanyId'> = {
  now: NOW,
  minAgeMs: 5 * MINUTE,
  windowMs: 23 * HOUR,
  maxCompanies: 1_000,
  maxContactsPerCompany: 50,
};

/** Varre tudo e devolve só os alvos das empresas deste teste (o banco de testes pode ter outras). */
async function scanFor(companies: readonly Company[]): Promise<ResumeTarget[]> {
  const ids = new Set<string>(companies.map((company) => company.id));
  const result = await reader.scan({ ...OPTIONS, afterCompanyId: null });
  return result.targets.filter((target) => ids.has(target.companyId));
}

async function newCompany(label: string): Promise<Company> {
  return tenants.createCompany(label, phoneNumber());
}

async function conversation(
  company: Company,
  contactRef: string,
  extra: { aiPausedUntil?: Date; aiIgnoreBefore?: Date } = {},
): Promise<string> {
  const row = await db().conversation.create({
    data: { companyId: company.id, contactRef, ...extra },
  });
  return row.id;
}

async function userMessage(company: Company, conversationId: string, createdAt: Date) {
  return db().message.create({
    data: {
      companyId: company.id,
      conversationId,
      role: 'USER',
      content: 'texto-secreto-retomada',
      externalId: `wamid.${randomBytes(8).toString('hex')}`,
      createdAt,
    },
  });
}

/** Mensagem do contato respondida por uma resposta do assistente (enviada ou não). */
async function answered(
  company: Company,
  conversationId: string,
  userAt: Date,
  reply: { at: Date; sent: boolean },
) {
  const user = await userMessage(company, conversationId, userAt);
  const assistant = await db().message.create({
    data: {
      companyId: company.id,
      conversationId,
      role: 'ASSISTANT',
      content: 'resposta-secreta',
      replyToId: user.id,
      createdAt: reply.at,
      ...(reply.sent ? { sentAt: reply.at, channelMessageId: `wamid.out.${user.id}` } : {}),
    },
  });
  await db().message.updateMany({
    where: { companyId: company.id, id: user.id },
    data: { answeredById: assistant.id },
  });
  return { user, assistant };
}

describe('PrismaResumeTargetReader (spec 035)', () => {
  it('pendente parada dentro da janela entra; recente demais e fora da janela não entram', async () => {
    const company = await newCompany('resume-pend');
    const stalled = contact();
    const recent = contact();
    const old = contact();
    await userMessage(company, await conversation(company, stalled), at(10 * MINUTE));
    await userMessage(company, await conversation(company, recent), at(2 * MINUTE));
    await userMessage(company, await conversation(company, old), at(24 * HOUR));

    const targets = await scanFor([company]);
    assert.deepEqual(
      targets.map((target) => [target.contactRef, target.kind]),
      [[stalled, 'pending']],
    );
    assert.equal(targets[0]?.phoneNumberId, company.whatsappPhoneNumberId);
  });

  it('pendente antiga com mensagem recente do contato entra (a janela conta da última mensagem dele)', async () => {
    const company = await newCompany('resume-janela');
    const ref = contact();
    const id = await conversation(company, ref);
    // A antiga ficou sem resposta (fora da janela sozinha), mas o contato voltou a escrever há 10 min.
    await userMessage(company, id, at(30 * HOUR));
    await userMessage(company, id, at(10 * MINUTE));
    const targets = await scanFor([company]);
    assert.deepEqual(
      targets.map((target) => target.contactRef),
      [ref],
    );
  });

  it('resposta gravada e não enviada (a última da conversa) entra como unsent; enviada não entra', async () => {
    const company = await newCompany('resume-unsent');
    const unsent = contact();
    const sent = contact();
    await answered(company, await conversation(company, unsent), at(30 * MINUTE), {
      at: at(29 * MINUTE),
      sent: false,
    });
    await answered(company, await conversation(company, sent), at(30 * MINUTE), {
      at: at(29 * MINUTE),
      sent: true,
    });
    const targets = await scanFor([company]);
    assert.deepEqual(
      targets.map((target) => [target.contactRef, target.kind]),
      [[unsent, 'unsent']],
    );
  });

  it('resposta não enviada que não é a última mensagem da conversa não entra como unsent', async () => {
    const company = await newCompany('resume-unsent-velha');
    const ref = contact();
    const id = await conversation(company, ref);
    await answered(company, id, at(40 * MINUTE), { at: at(39 * MINUTE), sent: false });
    await answered(company, id, at(20 * MINUTE), { at: at(19 * MINUTE), sent: true });
    assert.deepEqual(await scanFor([company]), []);
  });

  it('resposta segurada pela equipe (aiIgnoreBefore) nunca entra; IA pausada não entra em nenhum tipo', async () => {
    const company = await newCompany('resume-equipe');
    const held = contact();
    const paused = contact();
    const heldId = await conversation(company, held, { aiIgnoreBefore: at(5 * MINUTE) });
    await answered(company, heldId, at(30 * MINUTE), { at: at(29 * MINUTE), sent: false });
    const pausedId = await conversation(company, paused, {
      aiPausedUntil: new Date(NOW.getTime() + HOUR),
    });
    await userMessage(company, pausedId, at(10 * MINUTE));
    assert.deepEqual(await scanFor([company]), []);
  });

  it('o contato fixo do teste do site não entra', async () => {
    const company = await newCompany('resume-site');
    await userMessage(company, await conversation(company, SITE_TEST_CONTACT_REF), at(10 * MINUTE));
    assert.deepEqual(await scanFor([company]), []);
  });

  it('empresa suspensa, removida, sem número ou com credencial recusada não entra; reconectada volta', async () => {
    const suspended = await newCompany('resume-susp');
    const removed = await newCompany('resume-rem');
    const noNumber = await tenants.createCompany('resume-sem-numero');
    const tokenInvalid = await newCompany('resume-token');
    for (const company of [suspended, removed, noNumber, tokenInvalid]) {
      await userMessage(company, await conversation(company, contact()), at(10 * MINUTE));
    }
    await db().company.updateMany({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });
    await db().company.updateMany({ where: { id: removed.id }, data: { deletedAt: NOW } });
    await db().channelConnection.create({
      data: {
        companyId: tokenInvalid.id,
        wabaId: '1',
        tokenCiphertext: 'v1.k.iv.tag.ct',
        status: 'TOKEN_INVALID',
        tokenInvalidAt: NOW,
      },
    });
    assert.deepEqual(await scanFor([suspended, removed, noNumber, tokenInvalid]), []);

    await db().channelConnection.updateMany({
      where: { companyId: tokenInvalid.id },
      data: { status: 'CONNECTED', tokenInvalidAt: null },
    });
    const targets = await scanFor([tokenInvalid]);
    assert.equal(targets.length, 1);
  });

  it('isolamento: cada alvo leva a empresa e o número da própria empresa, e nunca o contato da outra', async () => {
    const companyA = await newCompany('resume-iso-a');
    const companyB = await newCompany('resume-iso-b');
    const shared = contact();
    const onlyB = contact();
    await userMessage(companyA, await conversation(companyA, shared), at(10 * MINUTE));
    await userMessage(companyB, await conversation(companyB, shared), at(10 * MINUTE));
    await userMessage(companyB, await conversation(companyB, onlyB), at(10 * MINUTE));

    const targets = await scanFor([companyA, companyB]);
    const ofA = targets.filter((target) => target.companyId === companyA.id);
    const ofB = targets.filter((target) => target.companyId === companyB.id);
    assert.deepEqual(
      ofA.map((target) => [target.contactRef, target.phoneNumberId]),
      [[shared, companyA.whatsappPhoneNumberId]],
    );
    assert.deepEqual(ofB.map((target) => target.contactRef).sort(), [shared, onlyB].sort());
    for (const target of ofB) assert.equal(target.phoneNumberId, companyB.whatsappPhoneNumberId);
  });

  it('rodízio: com página cheia devolve o cursor; a chamada seguinte começa depois dele', async () => {
    const companies = [
      await newCompany('resume-rod-1'),
      await newCompany('resume-rod-2'),
      await newCompany('resume-rod-3'),
    ];
    for (const company of companies) {
      await userMessage(company, await conversation(company, contact()), at(10 * MINUTE));
    }
    const ours = new Set<string>(companies.map((company) => company.id));
    const seen: string[] = [];
    let cursor = null as string | null;
    // Páginas de uma empresa: percorre o banco inteiro e encontra as três, cada uma uma vez.
    for (let page = 0; page < 10_000; page += 1) {
      const result = await reader.scan({ ...OPTIONS, maxCompanies: 1, afterCompanyId: cursor });
      for (const target of result.targets) {
        if (ours.has(target.companyId)) seen.push(target.companyId);
      }
      if (result.nextCompanyId === null) break;
      assert.ok(cursor === null || result.nextCompanyId > cursor, 'o cursor só anda para a frente');
      cursor = result.nextCompanyId;
    }
    assert.deepEqual(seen.sort(), [...ours].sort());
  });

  it('respeita o teto de contatos por empresa', async () => {
    const company = await newCompany('resume-teto');
    for (let index = 0; index < 4; index += 1) {
      await userMessage(company, await conversation(company, contact()), at(10 * MINUTE));
    }
    const result = await reader.scan({
      ...OPTIONS,
      maxContactsPerCompany: 2,
      afterCompanyId: null,
    });
    assert.equal(result.targets.filter((target) => target.companyId === company.id).length, 2);
  });
});
