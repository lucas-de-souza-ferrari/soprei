import { z } from 'zod';

/**
 * Formulário de contato comercial (spec 040, E4): regras puras do site. A validação aqui é só conveniência (o
 * servidor valida tudo de novo, com as mesmas regras); as mensagens de erro do envio são escolhidas pelo
 * `status` e pelo `error.code`, nunca pelo texto do servidor. Nada do formulário vai a `localStorage`,
 * `sessionStorage`, URL nem título: o rascunho vive só em memória.
 */

/** Página pública do formulário. */
export const CONTACT_PATH = '/fale-conosco';

export const UNITS_OPTIONS = [
  { value: '1-10', label: 'De 1 a 10' },
  { value: '11-30', label: 'De 11 a 30' },
  { value: '31-100', label: 'De 31 a 100' },
  { value: '100+', label: 'Mais de 100' },
] as const;

export const VOLUME_OPTIONS = [
  { value: 'ate-30-mil', label: 'Até 30 mil por mês' },
  { value: '30-a-100-mil', label: 'De 30 mil a 100 mil por mês' },
  { value: '100-a-500-mil', label: 'De 100 mil a 500 mil por mês' },
  { value: 'mais-de-500-mil', label: 'Mais de 500 mil por mês' },
  { value: 'nao-sei', label: 'Ainda não sei' },
] as const;

export type UnitsValue = (typeof UNITS_OPTIONS)[number]['value'];
export type VolumeValue = (typeof VOLUME_OPTIONS)[number]['value'];

export interface SalesContactDraft {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly companyName: string;
  readonly units: UnitsValue | '';
  readonly monthlyVolume: VolumeValue | '';
  readonly message: string;
  readonly privacyAck: boolean;
  /** Honeypot: escondido de pessoas e do leitor de tela; quem preenche é robô. */
  readonly website: string;
}

export const EMPTY_DRAFT: SalesContactDraft = {
  name: '',
  email: '',
  phone: '',
  companyName: '',
  units: '',
  monthlyVolume: '',
  message: '',
  privacyAck: false,
  website: '',
};

export type DraftField = Exclude<keyof SalesContactDraft, 'website'>;
export type DraftErrors = Partial<Record<DraftField, string>>;

/** Ordem dos campos na tela (o foco vai ao primeiro com erro). */
export const FIELD_ORDER: readonly DraftField[] = [
  'name',
  'email',
  'phone',
  'companyName',
  'units',
  'monthlyVolume',
  'message',
  'privacyAck',
];

export const FIELD_ERRORS: Readonly<Record<DraftField, string>> = {
  name: 'Informe o seu nome (de 2 a 100 caracteres).',
  email: 'Informe um e-mail válido.',
  phone: 'Use de 8 a 15 dígitos (pode ter espaço, +, parênteses e hífen) ou deixe em branco.',
  companyName: 'Informe o nome da empresa (de 2 a 120 caracteres).',
  units: 'Escolha a quantidade de empresas ou unidades.',
  monthlyVolume: 'Escolha o volume estimado de mensagens.',
  message: 'Escreva a mensagem (de 10 a 2.000 caracteres, até 40 linhas).',
  privacyAck: 'Confirme que leu a Política de Privacidade.',
};

const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
/** Separadores de linha Unicode (U+2028 e U+2029): o servidor os recusa nos campos de uma linha. */
const LINE_SEPARATOR = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`);

function singleLineOk(value: string, min: number, max: number): boolean {
  const text = value.normalize('NFC').trim();
  return (
    text.length >= min &&
    text.length <= max &&
    !CONTROL.test(text) &&
    !FORMAT.test(text) &&
    !LINE_SEPARATOR.test(text)
  );
}

function messageOk(value: string): boolean {
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  return (
    text.length >= 10 &&
    text.length <= 2_000 &&
    !/[^\P{Cc}\n]/u.test(text) &&
    !FORMAT.test(text) &&
    text.split('\n').length <= 40
  );
}

function phoneOk(value: string): boolean {
  const text = value.trim();
  if (text === '') return true;
  if (!/^[0-9 +()-]{8,20}$/.test(text)) return false;
  const digits = text.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
}

const emailOk = (value: string): boolean => {
  const text = value.normalize('NFKC').trim().toLowerCase();
  return text.length <= 254 && z.email().safeParse(text).success;
};

/** Erros por campo, com as mesmas regras do servidor (spec 040, D17). Vazio = pode enviar. */
export function validateDraft(draft: SalesContactDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!singleLineOk(draft.name, 2, 100)) errors.name = FIELD_ERRORS.name;
  if (!emailOk(draft.email)) errors.email = FIELD_ERRORS.email;
  if (!phoneOk(draft.phone)) errors.phone = FIELD_ERRORS.phone;
  if (!singleLineOk(draft.companyName, 2, 120)) errors.companyName = FIELD_ERRORS.companyName;
  if (draft.units === '') errors.units = FIELD_ERRORS.units;
  if (draft.monthlyVolume === '') errors.monthlyVolume = FIELD_ERRORS.monthlyVolume;
  if (!messageOk(draft.message)) errors.message = FIELD_ERRORS.message;
  if (!draft.privacyAck) errors.privacyAck = FIELD_ERRORS.privacyAck;
  return errors;
}

export function firstInvalid(errors: DraftErrors): DraftField | undefined {
  return FIELD_ORDER.find((field) => errors[field] !== undefined);
}

/** Há algo escrito ou escolhido (fechar o diálogo pede confirmação). O honeypot não conta. */
export function isDraftDirty(draft: SalesContactDraft): boolean {
  return (
    draft.name.trim() !== '' ||
    draft.email.trim() !== '' ||
    draft.phone.trim() !== '' ||
    draft.companyName.trim() !== '' ||
    draft.units !== '' ||
    draft.monthlyVolume !== '' ||
    draft.message.trim() !== '' ||
    draft.privacyAck
  );
}

/** Corpo de `POST /contact/sales`. O telefone vazio não é enviado. */
export function toPayload(draft: SalesContactDraft, formToken: string): Record<string, unknown> {
  const phone = draft.phone.trim();
  return {
    name: draft.name.trim(),
    email: draft.email.trim(),
    ...(phone === '' ? {} : { phone }),
    companyName: draft.companyName.trim(),
    units: draft.units,
    monthlyVolume: draft.monthlyVolume,
    message: draft.message.trim(),
    privacyAck: draft.privacyAck,
    website: draft.website,
    formToken,
  };
}

/**
 * Texto do sucesso: sempre esta frase fixa (o texto do servidor nunca é mostrado). É a mesma resposta do servidor
 * em todo 202, inclusive nos descartes silenciosos.
 */
export const ACCEPTED_MESSAGE = 'Recebemos o seu contato. Responderemos pelo e-mail informado.';

/**
 * Tempo mínimo entre receber o token do formulário e enviar (spec 040, revisão da E4). O servidor descarta em
 * silêncio o envio com token de menos de 3 s (`too_fast`); com folga, o site espera a diferença antes do POST
 * (reenvio logo depois de `FORM_EXPIRED`, preenchimento automático), em vez de perder o pedido.
 */
export const SUBMIT_MIN_TOKEN_AGE_MS = 3_500;

/** Quanto esperar antes do POST, dado o instante em que o token chegou (ms, relógio do navegador). */
export function waitBeforeSubmit(tokenReceivedAt: number, now: number): number {
  return Math.max(
    0,
    Math.min(SUBMIT_MIN_TOKEN_AGE_MS, tokenReceivedAt + SUBMIT_MIN_TOKEN_AGE_MS - now),
  );
}

const formTokenSchema = z.object({ formToken: z.string().min(1).max(200) });

export function parseFormToken(body: unknown): string | null {
  const parsed = formTokenSchema.safeParse(body);
  return parsed.success ? parsed.data.formToken : null;
}

/** Mensagem do envio que falhou: só pelo `status` e pelo `error.code`. */
export function submitErrorMessage(status: number, code: string | undefined): string {
  if (status === 400 && code === 'FORM_EXPIRED')
    return 'O formulário ficou aberto por muito tempo. Confira os dados e envie de novo.';
  if (status === 400) return 'Confira os campos do formulário e tente de novo.';
  if (status === 403) return 'Não foi possível enviar desta página. Recarregue e tente de novo.';
  if (status === 404) return 'O contato comercial não está disponível neste ambiente.';
  if (status === 413) return 'A mensagem ficou grande demais. Encurte o texto e tente de novo.';
  if (status === 429) return 'Muitos envios em pouco tempo. Tente de novo mais tarde.';
  return 'Não foi possível enviar agora. Tente de novo em alguns minutos.';
}

/** Falha ao abrir o formulário (pedir o token). */
export function tokenErrorMessage(status: number): string {
  if (status === 404) return 'O contato comercial não está disponível neste ambiente.';
  if (status === 429) return 'Muitos acessos em pouco tempo. Tente de novo mais tarde.';
  return 'Não foi possível abrir o formulário agora. Tente de novo em alguns minutos.';
}
