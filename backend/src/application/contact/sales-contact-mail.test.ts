import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SALES_CONTACT_PRIVACY_VERSION, type SalesContactRequest } from '../../domain/index.js';
import {
  SALES_CONTACT_MAIL_SUBJECT,
  salesContactMailText,
  sanitizeLine,
  sanitizeMessage,
} from './sales-contact-mail.js';

const REQUEST: SalesContactRequest = {
  name: 'Maria Souza',
  email: 'maria@empresa.test',
  phone: '+55 (11) 98888-7777',
  companyName: 'Rede Exemplo',
  units: '31-100',
  monthlyVolume: '100-a-500-mil',
  message: 'Temos 40 lojas.\r\nQueremos uma proposta.',
};

describe('e-mail de contato comercial (spec 040, E4)', () => {
  it('assunto fixo, sem nada do formulário', () => {
    assert.equal(SALES_CONTACT_MAIL_SUBJECT, 'Novo contato comercial pelo site do Soprei');
  });

  it('rótulos fixos, faixas por tabela e a linha de ciência da política versão 2', () => {
    const lines = salesContactMailText(REQUEST).split('\n');
    assert.ok(lines.includes('Nome: Maria Souza'));
    assert.ok(lines.includes('E-mail: maria@empresa.test'));
    assert.ok(lines.includes('Telefone ou WhatsApp: +55 (11) 98888-7777'));
    assert.ok(lines.includes('Empresa: Rede Exemplo'));
    assert.ok(lines.includes('Empresas ou unidades: de 31 a 100'));
    assert.ok(lines.includes('Volume estimado de mensagens: de 100 mil a 500 mil por mês'));
    assert.ok(lines.includes('Temos 40 lojas.'));
    assert.ok(lines.includes('Queremos uma proposta.'));
    assert.equal(lines.at(-1), 'Ciência da Política de Privacidade (versão 2): sim');
    assert.ok(!salesContactMailText(REQUEST).includes('\r'));
  });

  it('telefone ausente = "não informado"', () => {
    assert.ok(
      salesContactMailText({ ...REQUEST, phone: undefined })
        .split('\n')
        .includes('Telefone ou WhatsApp: não informado'),
    );
  });

  it('nome e empresa com CR LF injetado chegam numa linha só; Cf (U+202E) removido', () => {
    const text = salesContactMailText({
      ...REQUEST,
      name: 'Maria\r\nBcc: alvo@x.test',
      companyName: 'Rede‮ Exemplo Linha​',
      message: 'Oi‮ tudo\r bem?\u0007 Fim novo',
    });
    const lines = text.split('\n');
    assert.ok(lines.includes('Nome: Maria Bcc: alvo@x.test'));
    assert.ok(lines.includes('Empresa: Rede Exemplo Linha'));
    assert.ok(!lines.some((line) => line.startsWith('Bcc:')));
    assert.doesNotMatch(text, /\p{Cf}/u);
    assert.ok(lines.includes('Oi tudo'));
    assert.ok(lines.includes(' bem? Fim'));
    assert.ok(lines.includes('novo'));
    assert.doesNotMatch(text, /[^\P{Cc}\n]/u);
  });

  it('sanitizeLine e sanitizeMessage', () => {
    assert.equal(sanitizeLine('  a\tb\n\nc  '), 'a b c');
    assert.equal(sanitizeLine('x‮y⁦z'), 'xyz');
    assert.equal(sanitizeMessage('a\r\nb\rc\u0000d'), 'a\nb\ncd');
  });

  it('a versão da política citada no e-mail é a de frontend/src/legal/privacidade.md', () => {
    const policy = readFileSync(
      new URL('../../../../frontend/src/legal/privacidade.md', import.meta.url),
      'utf8',
    );
    const version = /^versao: (\d+)$/m.exec(policy)?.[1];
    assert.equal(version, String(SALES_CONTACT_PRIVACY_VERSION));
    assert.ok(
      salesContactMailText(REQUEST).includes(
        `Ciência da Política de Privacidade (versão ${String(SALES_CONTACT_PRIVACY_VERSION)}): sim`,
      ),
    );
  });
});
