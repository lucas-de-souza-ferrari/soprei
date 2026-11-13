import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SalesContactRequest } from '../../domain/index.js';
import type { SalesContactResult } from '../../infrastructure/metrics/index.js';
import { ServiceUnavailableError, ValidationError } from '../../shared/errors/index.js';
import type {
  SalesContactDailyCap,
  SalesContactMail,
  SalesContactMailer,
} from '../ports/sales-contact.js';
import { deriveSalesContactKey, issueFormToken } from './form-token.js';
import { SALES_CONTACT_MAIL_SUBJECT } from './sales-contact-mail.js';
import { SalesContactService } from './sales-contact.service.js';

const KEY = deriveSalesContactKey('k'.repeat(48));
const DAY1 = Date.UTC(2026, 10, 13, 23, 0, 0);

const REQUEST: SalesContactRequest = {
  name: 'Maria',
  email: 'maria@empresa.test',
  companyName: 'Rede',
  units: '1-10',
  monthlyVolume: 'nao-sei',
  message: 'Quero uma proposta.',
};

class MemoryCap implements SalesContactDailyCap {
  readonly counts = new Map<string, number>();
  down = false;
  constructor(private readonly cap = 30) {}
  take(day: string): Promise<boolean> {
    if (this.down) return Promise.reject(new ServiceUnavailableError('fora'));
    const count = (this.counts.get(day) ?? 0) + 1;
    this.counts.set(day, count);
    return Promise.resolve(count <= this.cap);
  }
}

class FakeMailer implements SalesContactMailer {
  readonly sent: { to: string; mail: SalesContactMail }[] = [];
  fail = false;
  hold: Promise<void> | undefined;
  async sendSalesContact(to: string, mail: SalesContactMail): Promise<void> {
    if (this.hold !== undefined) await this.hold;
    if (this.fail) throw new ServiceUnavailableError('smtp');
    this.sent.push({ to, mail });
  }
}

function world(options: { cap?: number } = {}) {
  let now = DAY1;
  const results: SalesContactResult[] = [];
  const logs: unknown[] = [];
  const warns: unknown[] = [];
  const mailer = new FakeMailer();
  const cap = new MemoryCap(options.cap);
  const logger = {
    info: (obj: unknown) => logs.push(obj),
    warn: (obj: unknown) => {
      logs.push(obj);
      warns.push(obj);
    },
  } as never;
  const service = new SalesContactService({
    mailer,
    cap,
    formKey: KEY,
    recipient: 'vendas@soprei.test',
    logger,
    metrics: { countSalesContact: (result) => results.push(result) },
    now: () => new Date(now),
  });
  return {
    service,
    mailer,
    cap,
    results,
    logs,
    warns,
    setNow: (ms: number) => {
      now = ms;
    },
    // Token emitido 10 s antes de "agora".
    token: () => issueFormToken(KEY, now - 10_000),
  };
}

describe('SalesContactService (spec 040, E4)', () => {
  it('caso válido: um e-mail para a caixa comercial, assunto fixo e Reply-To do interessado', async () => {
    const w = world();
    await w.service.submit({ request: REQUEST, formToken: w.token() });
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 1);
    const [sent] = w.mailer.sent;
    assert.ok(sent);
    assert.equal(sent.to, 'vendas@soprei.test');
    assert.equal(sent.mail.subject, SALES_CONTACT_MAIL_SUBJECT);
    assert.equal(sent.mail.replyTo, 'maria@empresa.test');
    assert.deepEqual(w.results, ['sent']);
    assert.deepEqual(w.logs, [{ result: 'sent' }]);
  });

  it('honeypot preenchido: aceito em silêncio, nada enviado, sem gastar o teto', async () => {
    const w = world();
    await w.service.submit({ request: REQUEST, website: 'http://spam', formToken: 'qualquer' });
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    assert.equal(w.cap.counts.size, 0);
    assert.deepEqual(w.results, ['spam']);
  });

  it('honeypot só com espaço não é robô', async () => {
    const w = world();
    await w.service.submit({ request: REQUEST, website: '   ', formToken: w.token() });
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 1);
  });

  it('token com menos de 3 s: aceito em silêncio, nada enviado', async () => {
    const w = world();
    await w.service.submit({ request: REQUEST, formToken: issueFormToken(KEY, DAY1 - 1_000) });
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    assert.deepEqual(w.results, ['too_fast']);
  });

  it('token alterado ou com mais de 2 h: FORM_EXPIRED, nada enviado', async () => {
    const w = world();
    for (const token of ['1.abc', issueFormToken(KEY, DAY1 - 2 * 3_600_000 - 1)]) {
      await assert.rejects(
        w.service.submit({ request: REQUEST, formToken: token }),
        (error: unknown) => error instanceof ValidationError && error.code === 'FORM_EXPIRED',
      );
    }
    assert.equal(w.mailer.sent.length, 0);
    assert.deepEqual(w.results, ['expired', 'expired']);
  });

  it('teto diário: o 31º pedido do dia não envia; no dia seguinte volta a enviar', async () => {
    const w = world();
    for (let i = 0; i < 31; i += 1) {
      await w.service.submit({ request: REQUEST, formToken: w.token() });
      await w.service.drain();
    }
    assert.equal(w.mailer.sent.length, 30);
    assert.equal(w.results.at(-1), 'daily_cap');
    // Mais um recusado no mesmo dia: um único warn por dia, só com o resultado.
    await w.service.submit({ request: REQUEST, formToken: w.token() });
    assert.equal(w.results.at(-1), 'daily_cap');
    assert.equal(w.warns.length, 1);
    assert.deepEqual(w.warns[0], { result: 'daily_cap' });
    assert.equal(w.results.filter((r) => r === 'sent').length, 30);
    w.setNow(DAY1 + 2 * 3_600_000); // 01:00 UTC do dia seguinte
    await w.service.submit({ request: REQUEST, formToken: w.token() });
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 31);
    assert.deepEqual([...w.cap.counts.keys()], ['2026-11-13', '2026-11-14']);
  });

  it('teto indisponível (Redis fora): 503 antes de qualquer envio', async () => {
    const w = world();
    w.cap.down = true;
    await assert.rejects(
      w.service.submit({ request: REQUEST, formToken: w.token() }),
      ServiceUnavailableError,
    );
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
  });

  it('falha do SMTP: resolve normalmente, métrica failed, log só com o resultado', async () => {
    const w = world();
    w.mailer.fail = true;
    await w.service.submit({ request: REQUEST, formToken: w.token() });
    await w.service.drain();
    assert.deepEqual(w.results, ['failed']);
    assert.deepEqual(w.logs, [{ result: 'failed' }]);
  });

  it('no máximo 10 envios em andamento; drain() espera os pendentes', async () => {
    const w = world();
    let release: () => void = () => undefined;
    w.mailer.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let i = 0; i < 11; i += 1) {
      await w.service.submit({ request: REQUEST, formToken: w.token() });
    }
    assert.deepEqual(w.results, ['capped']);
    assert.equal(w.cap.counts.get('2026-11-13'), 10, 'a fila cheia não gasta o teto');
    let drained = false;
    const draining = w.service.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release();
    await draining;
    assert.equal(w.mailer.sent.length, 10);
  });

  it('recordInvalid só conta o resultado', () => {
    const w = world();
    w.service.recordInvalid();
    assert.deepEqual(w.results, ['invalid']);
    assert.deepEqual(w.logs, [{ result: 'invalid' }]);
  });
});
