import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../App';
import { ThemeProvider } from '../theme/theme-provider';
import { ContactPage } from './ContactPage';
import { EnterpriseCard } from './EnterpriseCard';
import {
  ACCEPTED_FALLBACK,
  acceptedMessage,
  CONTACT_PATH,
  EMPTY_DRAFT,
  FIELD_ERRORS,
  firstInvalid,
  parseFormToken,
  type SalesContactDraft,
  submitErrorMessage,
  toPayload,
  tokenErrorMessage,
  UNITS_OPTIONS,
  validateDraft,
  VOLUME_OPTIONS,
} from './sales-contact-rules';

const VALID: SalesContactDraft = {
  name: 'Maria Souza',
  email: 'maria@empresa.test',
  phone: '',
  companyName: 'Rede Exemplo',
  units: '31-100',
  monthlyVolume: 'nao-sei',
  message: 'Queremos uma proposta para 40 lojas.',
  privacyAck: true,
  website: '',
};

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<ThemeProvider>{node}</ThemeProvider>);

describe('regras do formulário de contato (spec 040, E4)', () => {
  it('as faixas são as mesmas do servidor', () => {
    assert.deepEqual(
      UNITS_OPTIONS.map((option) => option.value),
      ['1-10', '11-30', '31-100', '100+'],
    );
    assert.deepEqual(
      VOLUME_OPTIONS.map((option) => option.value),
      ['ate-30-mil', '30-a-100-mil', '100-a-500-mil', 'mais-de-500-mil', 'nao-sei'],
    );
  });

  it('rascunho válido não tem erro; vazio tem erro em todos os campos obrigatórios, na ordem', () => {
    assert.deepEqual(validateDraft(VALID), {});
    const empty = validateDraft(EMPTY_DRAFT);
    assert.deepEqual(Object.keys(empty).sort(), [
      'companyName',
      'email',
      'message',
      'monthlyVolume',
      'name',
      'privacyAck',
      'units',
    ]);
    assert.equal(firstInvalid(empty), 'name');
    assert.equal(firstInvalid({ message: FIELD_ERRORS.message }), 'message');
  });

  it('limites iguais aos do servidor (nome, empresa, mensagem, telefone, e-mail)', () => {
    const errorOf = (patch: Partial<SalesContactDraft>) => validateDraft({ ...VALID, ...patch });
    assert.ok(errorOf({ name: 'A' }).name);
    assert.ok(errorOf({ name: 'N'.repeat(101) }).name);
    assert.equal(errorOf({ name: 'Ab' }).name, undefined);
    assert.ok(errorOf({ name: 'Maria‮' }).name);
    assert.ok(errorOf({ companyName: 'E'.repeat(121) }).companyName);
    assert.ok(errorOf({ message: 'curta' }).message);
    assert.ok(errorOf({ message: 'M'.repeat(2_001) }).message);
    assert.ok(errorOf({ message: Array.from({ length: 41 }, () => 'linha').join('\n') }).message);
    assert.equal(
      errorOf({ message: Array.from({ length: 40 }, () => 'linha').join('\n') }).message,
      undefined,
    );
    assert.equal(errorOf({ phone: '+55 (11) 98888-7777' }).phone, undefined);
    assert.ok(errorOf({ phone: '1234 567' }).phone);
    assert.ok(errorOf({ phone: '1234567890123456' }).phone);
    assert.ok(errorOf({ phone: '1234-5678x' }).phone);
    assert.ok(errorOf({ email: 'nao-e-email' }).email);
    assert.ok(errorOf({ privacyAck: false }).privacyAck);
  });

  it('payload: campos aparados, telefone vazio omitido, honeypot e token incluídos', () => {
    assert.deepEqual(toPayload({ ...VALID, name: '  Maria Souza  ' }, 'tok'), {
      name: 'Maria Souza',
      email: 'maria@empresa.test',
      companyName: 'Rede Exemplo',
      units: '31-100',
      monthlyVolume: 'nao-sei',
      message: 'Queremos uma proposta para 40 lojas.',
      privacyAck: true,
      website: '',
      formToken: 'tok',
    });
    assert.equal(toPayload({ ...VALID, phone: ' 11 98888-7777 ' }, 't').phone, '11 98888-7777');
  });

  it('erros escolhidos só por status e error.code', () => {
    assert.match(submitErrorMessage(400, 'FORM_EXPIRED'), /aberto por muito tempo/);
    assert.match(submitErrorMessage(400, 'VALIDATION_ERROR'), /Confira os campos/);
    assert.match(submitErrorMessage(403, undefined), /Recarregue/);
    assert.match(submitErrorMessage(404, undefined), /não está disponível/);
    assert.match(submitErrorMessage(429, 'RATE_LIMITED'), /Muitos envios/);
    assert.match(submitErrorMessage(503, 'SERVICE_UNAVAILABLE'), /alguns minutos/);
    assert.match(submitErrorMessage(0, undefined), /alguns minutos/);
    assert.match(tokenErrorMessage(404), /não está disponível/);
    assert.match(tokenErrorMessage(500), /abrir o formulário/);
  });

  it('mensagem do servidor só no formato esperado; token só como texto curto', () => {
    assert.equal(acceptedMessage({ message: 'Recebido.' }), 'Recebido.');
    assert.equal(acceptedMessage({ message: '<b>x</b>' }), ACCEPTED_FALLBACK);
    assert.equal(acceptedMessage({ message: 'a\nb' }), ACCEPTED_FALLBACK);
    assert.equal(acceptedMessage(null), ACCEPTED_FALLBACK);
    assert.equal(parseFormToken({ formToken: '1.abc' }), '1.abc');
    assert.equal(parseFormToken({}), null);
    assert.equal(parseFormToken({ formToken: 'x'.repeat(201) }), null);
  });
});

describe('telas do contato comercial (spec 040, E4)', () => {
  it('cartão Enterprise: "Sob consulta", botão "Falar com a gente", sem rádio nem preço', () => {
    const html = render(<EnterpriseCard />);
    assert.match(html, /Enterprise/);
    assert.match(html, /Sob consulta/);
    assert.match(html, /mais de 10 empresas ou mais de 30 mil respostas por\s+mês/);
    assert.match(html, /Falar com a gente/);
    assert.doesNotMatch(html, /type="radio"/);
    assert.doesNotMatch(html, /R\$/);
    // O formulário só é montado com o diálogo aberto.
    assert.doesNotMatch(html, /<form/);
  });

  it('/fale-conosco: formulário com honeypot fora do leitor de tela e da tabulação, link para /privacidade', () => {
    assert.equal(CONTACT_PATH, '/fale-conosco');
    const html = render(<ContactPage />);
    assert.match(html, /<h1[^>]*>Fale com a gente<\/h1>/);
    assert.match(html, /<form/);
    assert.match(
      html,
      /<div aria-hidden="true" inert=""[^>]*><label[^>]*>Site<\/label><input[^>]*name="website"/,
    );
    assert.match(html, /name="website"[^>]*tabindex="-1"|tabindex="-1"[^>]*name="website"/);
    assert.match(html, /autoComplete="off"|autocomplete="off"/);
    assert.match(html, /href="\/privacidade"/);
    assert.doesNotMatch(html, /localStorage|sessionStorage/);
  });

  it('página inicial: link "Fale com a gente" no menu e no rodapé', () => {
    const html = render(<App />);
    assert.equal(html.match(/href="\/fale-conosco"/g)?.length, 2);
  });

  it('o main.tsx monta /fale-conosco fora do AccountApp e o formulário não usa storage', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    assert.match(main, /location\.pathname === CONTACT_PATH \? \(\s*<ContactPage \/>/);
    for (const file of ['SalesContactForm.tsx', 'sales-contact-rules.ts', 'ContactPage.tsx']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(
        source,
        /localStorage\.|sessionStorage\.|document\.title|history\./,
        file,
      );
    }
  });
});
