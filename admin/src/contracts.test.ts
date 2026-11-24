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
  companyDetail,
  companyPage,
  health,
  noticePage,
  orderPage,
  overview,
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
    assert.equal(healthSchema.safeParse({ ...health, queue: { status: 'talvez' } }).success, false);
  });

  it('cobrança desligada: listas com items nulos e overview sem assinaturas', () => {
    assert.ok(orderPageSchema.safeParse({ items: null, nextCursor: null }).success);
    assert.ok(noticePageSchema.safeParse({ items: null, nextCursor: null }).success);
    assert.ok(
      overviewSchema.safeParse({
        ...overview,
        billingEnabled: false,
        subscriptions: null,
        paidThisMonth: null,
      }).success,
    );
    assert.ok(
      companyDetailSchema.safeParse({
        ...companyDetail(),
        billingEnabled: false,
        subscription: null,
      }).success,
    );
  });

  it('o corpo das ações aceita só os quatro motivos e nada mais', () => {
    for (const reason of ['PAYMENT', 'ABUSE', 'OWNER_REQUEST', 'OTHER'])
      assert.ok(actionBodySchema.safeParse({ reason }).success, reason);
    assert.equal(actionBodySchema.safeParse({ reason: 'BORED' }).success, false);
    assert.equal(actionBodySchema.safeParse({ reason: 'ABUSE', note: 'x' }).success, false);
  });
});
