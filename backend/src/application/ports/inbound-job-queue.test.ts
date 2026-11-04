import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { channelJobSchema, flushKey, inboundJobId } from './inbound-job-queue.js';

// Spec 022: o formato das chaves de job não muda com o renome (derivam do VALOR do id da empresa).
const COMPANY = '0199c1d2-0000-7000-8000-000000000001';

describe('identidade dos jobs do canal (spec 022)', () => {
  it('inboundJobId e flushKey mantêm o formato e os valores de antes do renome', () => {
    assert.equal(
      inboundJobId({ companyId: COMPANY, externalId: 'wamid.ABC=' }),
      `${COMPANY}_wamid.ABC%3D`,
    );
    const digest = createHash('sha256').update('5511999990000').digest('hex').slice(0, 32);
    assert.equal(
      flushKey({ companyId: COMPANY, contactRef: '5511999990000' }),
      `flush_${COMPANY}_${digest}`,
    );
    assert.ok(!inboundJobId({ companyId: COMPANY, externalId: 'a:b' }).includes(':'));
  });

  it('o schema do job só aceita companyId; o campo antigo da empresa é recusado', () => {
    const current = {
      kind: 'flush',
      companyId: COMPANY,
      phoneNumberId: '123',
      contactRef: '5511999990000',
      requestId: 'req-12345678',
    };
    assert.equal(channelJobSchema.safeParse(current).success, true);
    const { companyId, ...rest } = current;
    assert.equal(channelJobSchema.safeParse({ ...rest, clientId: companyId }).success, false);
  });
});
