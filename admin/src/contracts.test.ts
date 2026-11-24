import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  accountDetailSchema,
  accountPageSchema,
  actionBodySchema,
  companyDetailSchema,
  companyPageSchema,
  healthSchema,
  noticePageSchema,
  orderPageSchema,
  overviewSchema,
  sessionSchema,
} from './contracts';
import {
  accountDetail,
  accountPage,
  billingOffPage,
  companyDetail,
  companyPage,
  health,
  noticePage,
  orderPage,
  overview,
  overviewBillingOff,
} from '../e2e/fixtures';

describe('contratos do admin (spec 044, E3)', () => {
  it('as fixturas do Playwright passam pelos contratos', () => {
    const cases = [
      [overviewSchema, overview],
      [companyPageSchema, companyPage],
      [companyDetailSchema, companyDetail('ACTIVE')],
      [companyDetailSchema, companyDetail('SUSPENDED')],
      [accountPageSchema, accountPage],
      [accountDetailSchema, accountDetail],
      [orderPageSchema, orderPage],
      [noticePageSchema, noticePage],
      [healthSchema, health],
    ] as const;
    for (const [schema, fixture] of cases) {
      const parsed = schema.safeParse(fixture);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    }
  });

  it('campo a mais do servidor é descartado (nunca chega à tela)', () => {
    const parsed = companyDetailSchema.parse({ ...companyDetail(), persona: 'TEXTO-SECRETO' });
    assert.equal('persona' in parsed, false);
    const list = accountPageSchema.parse({
      ...accountPage,
      items: accountPage.items.map((item) => ({ ...item, email: 'completo@exemplo.test' })),
    });
    assert.equal(JSON.stringify(list).includes('completo@exemplo.test'), false);
  });

  it('campo faltando ou de tipo errado é recusado', () => {
    assert.equal(overviewSchema.safeParse({ ...overview, attention: undefined }).success, false);
    assert.equal(
      companyPageSchema.safeParse({ ...companyPage, items: [{ ...companyPage.items[0], id: '1' }] })
        .success,
      false,
    );
    assert.equal(sessionSchema.safeParse({}).success, false);
    assert.equal(healthSchema.safeParse({ ...health, queue: { state: 'talvez' } }).success, false);
    // Agrupamento de chaves fixas: faltar uma chave é recusado.
    const withoutLegacy: Record<string, number> = { ...overview.channel.byState };
    delete withoutLegacy.LEGACY;
    assert.equal(
      overviewSchema.safeParse({
        ...overview,
        channel: { ...overview.channel, byState: withoutLegacy },
      }).success,
      false,
    );
    // O formato provisório (listas `{ key, count }`) não passa mais.
    assert.equal(
      overviewSchema.safeParse({ ...overview, companies: [{ key: 'ACTIVE', count: 1 }] }).success,
      false,
    );
  });

  it('cobrança desligada: listas vazias com billingEnabled false e overview sem assinaturas', () => {
    assert.ok(orderPageSchema.safeParse(billingOffPage).success);
    assert.ok(noticePageSchema.safeParse(billingOffPage).success);
    assert.equal(orderPageSchema.safeParse({ items: null, nextCursor: null }).success, false);
    assert.ok(overviewSchema.safeParse(overviewBillingOff).success);
    assert.ok(
      companyDetailSchema.safeParse({
        ...companyDetail(),
        billingEnabled: false,
        subscription: null,
        usage: null,
      }).success,
    );
    assert.ok(
      accountDetailSchema.safeParse({ ...accountDetail, billingEnabled: false, subscription: null })
        .success,
    );
  });

  it('chave a mais num agrupamento fixo é descartada; a fila aceita estados novos', () => {
    const parsed = overviewSchema.parse({
      ...overview,
      channel: { ...overview.channel, byMode: { ...overview.channel.byMode, OUTRO: 9 } },
    });
    assert.equal('OUTRO' in parsed.channel.byMode, false);
    const queue = healthSchema.parse({
      ...health,
      queue: { state: 'ok', jobs: { waiting: 1, prioritized: 2 } },
    }).queue;
    assert.deepEqual(queue, { state: 'ok', jobs: { waiting: 1, prioritized: 2 } });
    for (const resume of [{ state: 'disabled' }, { state: 'not_run' }])
      assert.ok(healthSchema.safeParse({ ...health, resume }).success);
  });

  it('o corpo das ações aceita só os quatro motivos e nada mais', () => {
    for (const reason of ['PAYMENT', 'ABUSE', 'OWNER_REQUEST', 'OTHER'])
      assert.ok(actionBodySchema.safeParse({ reason }).success, reason);
    assert.equal(actionBodySchema.safeParse({ reason: 'BORED' }).success, false);
    assert.equal(actionBodySchema.safeParse({ reason: 'ABUSE', note: 'x' }).success, false);
  });
});
