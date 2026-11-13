import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BILLING_NOTICE_KINDS } from '../../domain/index.js';
import { BILLING_NOTICE_SUBJECTS, billingNoticeMail, formatNoticeDate } from './billing-mail.js';

const ORIGIN = 'https://site.exemplo.test';
const DATA = {
  planName: 'Profissional',
  periodEnd: new Date('2026-12-01T12:00:00Z'),
  graceEnd: new Date('2026-12-06T12:00:00Z'),
  quota: { used: 2_560, limit: 3_200 },
} as const;

describe('e-mails de aviso de cobrança (spec 031, E5)', () => {
  it('todo tipo tem assunto fixo e corpo em texto simples com o link da tela de Assinatura', () => {
    for (const kind of BILLING_NOTICE_KINDS) {
      const mail = billingNoticeMail(kind, DATA, ORIGIN);
      assert.equal(mail.subject, BILLING_NOTICE_SUBJECTS[kind]);
      assert.ok(mail.text.includes(`${ORIGIN}/painel/assinatura`), kind);
      // Só o endereço da tela: sem token, sem query, sem fragmento.
      assert.ok(!/painel\/assinatura[?#]/.test(mail.text), kind);
      assert.ok(!mail.text.includes('<'), kind);
      // Nenhum valor em dinheiro nem dado de cartão (o valor do reajuste só entra com renewalCents, abaixo).
      assert.ok(
        !/R\$|cart[aã]o de|CVV/.test(mail.text.replace('dados de cartão por e-mail', '')),
        kind,
      );
    }
  });

  it('o assunto nunca leva nome de plano, data nem número', () => {
    for (const subject of Object.values(BILLING_NOTICE_SUBJECTS)) {
      assert.ok(!subject.includes('Profissional'));
      assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(subject));
    }
  });

  it('as datas saem em dd/MM/aaaa no fuso do Brasil (o fim do período próximo da meia-noite UTC não muda o dia)', () => {
    assert.equal(formatNoticeDate(new Date('2026-12-01T12:00:00Z')), '01/12/2026');
    assert.equal(formatNoticeDate(new Date('2026-12-01T02:30:00Z')), '30/11/2026');
  });

  it('vencido diz até quando vai a carência e que nada é apagado', () => {
    const text = billingNoticeMail('PERIOD_ENDED', DATA, ORIGIN).text;
    assert.ok(text.includes('01/12/2026'));
    assert.ok(text.includes('06/12/2026'));
    assert.ok(text.includes('Nada é apagado'));
  });

  it('o aviso de respostas mostra o uso e o de tokens não mostra contagem', () => {
    assert.ok(billingNoticeMail('QUOTA_REPLIES_80', DATA, ORIGIN).text.includes('2.560 de 3.200'));
    assert.ok(!billingNoticeMail('QUOTA_TOKENS_80', DATA, ORIGIN).text.includes('2.560'));
  });

  it('o nome do plano é tratado como texto livre: sem quebra de linha, controle nem excesso', () => {
    const hostile = `Plano\r\nBcc: alguem@exemplo.test${String.fromCharCode(0)}${'x'.repeat(200)}`;
    const text = billingNoticeMail('PAYMENT_RECEIVED', { ...DATA, planName: hostile }, ORIGIN).text;
    const line = text.split('\n').find((candidate) => candidate.startsWith('Seu plano'));
    assert.ok(line !== undefined);
    assert.ok(line.length < 200);
    assert.ok(!text.includes('\r'));
    assert.ok(!text.includes(String.fromCharCode(0)));
  });

  it('o aviso de limite da IA (QUOTA_TOKENS_100) não tem a palavra token nem contagens, e diz quando a IA volta (spec 040, D3)', () => {
    const mail = billingNoticeMail(
      'QUOTA_TOKENS_100',
      {
        ...DATA,
        quota: { used: 15_000_000, limit: 15_000_000 },
        nextWindowStart: new Date('2026-12-10T12:00:00Z'),
      },
      ORIGIN,
    );
    assert.equal(mail.subject, 'As respostas automáticas do Soprei pararam este mês');
    for (const part of [mail.subject, mail.text]) {
      assert.doesNotMatch(part, /token/i);
      // Nenhuma contagem (de tokens nem de respostas), em nenhum formato.
      assert.doesNotMatch(part, /15[.]?000[.]?000|15000000|15 M/);
      // Números com separador de milhar são contagem; a única sequência de dígitos é a data dd/MM/aaaa.
      assert.doesNotMatch(part, /\d[.]\d{3}/);
      assert.deepEqual(part.match(/\d+/g) ?? [], part === mail.text ? ['10', '12', '2026'] : []);
    }
    assert.ok(mail.text.includes('inteligência artificial'));
    assert.ok(mail.text.includes('antes da cota de respostas'));
    assert.ok(mail.text.includes('10/12/2026'), 'a data em que a IA volta');
    assert.ok(mail.text.includes('guardadas e visíveis no painel'));
  });

  it('o aviso de reajuste (PRICE_CHANGE) traz o valor do catálogo, a data da renovação e que dá para cancelar (spec 040, D6)', () => {
    const mail = billingNoticeMail('PRICE_CHANGE', { ...DATA, renewalCents: 349_000 }, ORIGIN);
    assert.equal(mail.subject, BILLING_NOTICE_SUBJECTS.PRICE_CHANGE);
    assert.ok(mail.text.includes('R$ 3.490,00'), mail.text);
    assert.ok(mail.text.includes('01/12/2026'));
    assert.ok(mail.text.includes('O período que você já pagou não muda'));
    assert.ok(mail.text.includes('cancelar'));
    assert.ok(!mail.text.includes(String.fromCharCode(0xa0)), 'sem espaço não separável');
    // O assunto não leva valor.
    assert.doesNotMatch(mail.subject, /R\$|\d/);
  });
});
