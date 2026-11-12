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
      // Nenhum valor em dinheiro nem dado de cartão.
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
});
