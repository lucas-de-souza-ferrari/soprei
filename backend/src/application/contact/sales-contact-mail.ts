import {
  SALES_CONTACT_PRIVACY_VERSION,
  type SalesContactRequest,
  type SalesContactUnits,
  type SalesContactVolume,
} from '../../domain/index.js';

/** Assunto fixo (spec 040, D16): nada do formulário no assunto. */
export const SALES_CONTACT_MAIL_SUBJECT = 'Novo contato comercial pelo site do Soprei';

const UNITS_TEXT: Readonly<Record<SalesContactUnits, string>> = {
  '1-10': 'de 1 a 10',
  '11-30': 'de 11 a 30',
  '31-100': 'de 31 a 100',
  '100+': 'mais de 100',
};

const VOLUME_TEXT: Readonly<Record<SalesContactVolume, string>> = {
  'ate-30-mil': 'até 30 mil por mês',
  '30-a-100-mil': 'de 30 mil a 100 mil por mês',
  '100-a-500-mil': 'de 100 mil a 500 mil por mês',
  'mais-de-500-mil': 'mais de 500 mil por mês',
  'nao-sei': 'não sei',
};

/**
 * Campo de uma linha: NFC, qualquer controle (inclusive `\r` e `\n`) e separador de linha viram espaço, os
 * caracteres invisíveis de formatação (Cf, como U+202E) saem, e espaços repetidos viram um. Defesa em
 * profundidade: o schema da rota já recusa tudo isso.
 */
export function sanitizeLine(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Mensagem: `\r\n` e `\r` viram `\n`; nenhum controle além de `\n`; sem Cf. */
export function sanitizeMessage(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029]/gu, '\n')
    .replace(/[^\P{Cc}\n]/gu, '')
    .replace(/\p{Cf}/gu, '')
    .trim();
}

/** Corpo em texto simples (spec 040, E4): rótulos fixos, valores higienizados e faixas por tabela fixa. */
export function salesContactMailText(request: SalesContactRequest): string {
  const phone = request.phone === undefined ? '' : sanitizeLine(request.phone);
  return [
    'Novo pedido de contato comercial pelo formulário do site.',
    '',
    `Nome: ${sanitizeLine(request.name)}`,
    `E-mail: ${sanitizeLine(request.email)}`,
    `Telefone ou WhatsApp: ${phone === '' ? 'não informado' : phone}`,
    `Empresa: ${sanitizeLine(request.companyName)}`,
    `Empresas ou unidades: ${UNITS_TEXT[request.units]}`,
    `Volume estimado de mensagens: ${VOLUME_TEXT[request.monthlyVolume]}`,
    '',
    'Mensagem:',
    sanitizeMessage(request.message),
    '',
    'Para responder, use "Responder": o endereço de resposta é o e-mail informado.',
    `Ciência da Política de Privacidade (versão ${String(SALES_CONTACT_PRIVACY_VERSION)}): sim`,
  ].join('\n');
}
