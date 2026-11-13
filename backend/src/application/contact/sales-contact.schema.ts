import { z } from 'zod';
import {
  SALES_CONTACT_UNITS,
  SALES_CONTACT_VOLUMES,
  type SalesContactRequest,
} from '../../domain/index.js';
import { emailSchema } from '../auth/credentials.js';

/**
 * Corpo de `POST /contact/sales` (spec 040, E4, D17). Texto em NFC e sem espaços nas pontas; os tamanhos são
 * medidos depois da normalização. Campos de uma linha recusam qualquer caractere de controle e os separadores
 * de linha Unicode; a mensagem aceita só a quebra de linha (`\r\n` e `\r` viram `\n`). Caracteres invisíveis de
 * formatação (categoria Cf, como U+202E) são recusados em todos os campos. As mensagens de erro são fixas por
 * campo: o valor recebido nunca volta na resposta.
 */

/** Teto do valor cru, antes da normalização (limita o trabalho dela). */
const RAW_MAX = 8_000;

const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
const LINE_SEPARATOR = /[\u2028\u2029]/u;

export const SALES_CONTACT_FIELD_MESSAGES = {
  name: 'Informe o seu nome (de 2 a 100 caracteres, numa linha).',
  email: 'Informe um e-mail válido.',
  phone: 'Telefone inválido: use de 8 a 15 dígitos (pode ter espaço, +, parênteses e hífen).',
  companyName: 'Informe o nome da empresa (de 2 a 120 caracteres, numa linha).',
  units: 'Escolha a quantidade de empresas ou unidades.',
  monthlyVolume: 'Escolha o volume estimado de mensagens.',
  message: 'Escreva a mensagem (de 10 a 2.000 caracteres, até 40 linhas).',
  privacyAck: 'Confirme que leu a Política de Privacidade.',
  website: 'Campo inválido.',
  formToken: 'Recarregue a página e tente de novo.',
  unknown: 'Campo não permitido.',
} as const;

export type SalesContactField = Exclude<keyof typeof SALES_CONTACT_FIELD_MESSAGES, 'unknown'>;

function singleLine(min: number, max: number, message: string): z.ZodType<string> {
  return z
    .string({ error: message })
    .max(RAW_MAX, message)
    .transform((value) => value.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(min, message)
        .max(max, message)
        .refine(
          (value) => !CONTROL.test(value) && !FORMAT.test(value) && !LINE_SEPARATOR.test(value),
          message,
        ),
    );
}

const MESSAGE_MAX_LINES = 40;

const messageSchema = z
  .string({ error: SALES_CONTACT_FIELD_MESSAGES.message })
  .max(RAW_MAX, SALES_CONTACT_FIELD_MESSAGES.message)
  .transform((value) =>
    value
      .normalize('NFC')
      .replace(/\r\n?|[\u2028\u2029]/gu, '\n')
      .trim(),
  )
  .pipe(
    z
      .string()
      .min(10, SALES_CONTACT_FIELD_MESSAGES.message)
      .max(2_000, SALES_CONTACT_FIELD_MESSAGES.message)
      .refine(
        (value) =>
          !/[^\P{Cc}\n]/u.test(value) &&
          !FORMAT.test(value) &&
          value.split('\n').length <= MESSAGE_MAX_LINES,
        SALES_CONTACT_FIELD_MESSAGES.message,
      ),
  );

/** 8 a 20 caracteres de dígitos, espaço, `+`, `(`, `)` e `-`, com 8 a 15 dígitos. Vazio = não informado. */
const phoneSchema = z
  .string({ error: SALES_CONTACT_FIELD_MESSAGES.phone })
  .max(RAW_MAX, SALES_CONTACT_FIELD_MESSAGES.phone)
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z.union([
      z.literal('').transform(() => undefined),
      z
        .string()
        .regex(/^[0-9 +()-]{8,20}$/, SALES_CONTACT_FIELD_MESSAGES.phone)
        .refine((value) => {
          const digits = value.replace(/\D/g, '').length;
          return digits >= 8 && digits <= 15;
        }, SALES_CONTACT_FIELD_MESSAGES.phone),
    ]),
  );

export const salesContactSchema = z.strictObject(
  {
    name: singleLine(2, 100, SALES_CONTACT_FIELD_MESSAGES.name),
    // O mesmo normalizador das contas (NFKC, minúsculas, até 254); recusa espaço e quebra de linha.
    email: emailSchema,
    phone: phoneSchema.optional(),
    companyName: singleLine(2, 120, SALES_CONTACT_FIELD_MESSAGES.companyName),
    units: z.enum(SALES_CONTACT_UNITS, { error: SALES_CONTACT_FIELD_MESSAGES.units }),
    monthlyVolume: z.enum(SALES_CONTACT_VOLUMES, {
      error: SALES_CONTACT_FIELD_MESSAGES.monthlyVolume,
    }),
    message: messageSchema,
    privacyAck: z.literal(true, { error: SALES_CONTACT_FIELD_MESSAGES.privacyAck }),
    // Honeypot: escondido de pessoas e do leitor de tela. Preenchido não é erro (o robô não deve saber):
    // quem decide é o serviço, que descarta em silêncio.
    website: z
      .string({ error: SALES_CONTACT_FIELD_MESSAGES.website })
      .max(RAW_MAX, SALES_CONTACT_FIELD_MESSAGES.website)
      .optional(),
    formToken: z
      .string({ error: SALES_CONTACT_FIELD_MESSAGES.formToken })
      .min(1, SALES_CONTACT_FIELD_MESSAGES.formToken)
      .max(200, SALES_CONTACT_FIELD_MESSAGES.formToken),
  },
  { error: SALES_CONTACT_FIELD_MESSAGES.unknown },
);

export type SalesContactBody = z.output<typeof salesContactSchema>;

/** O pedido de domínio (sem honeypot nem token). */
export function toSalesContactRequest(body: SalesContactBody): SalesContactRequest {
  return {
    name: body.name,
    email: body.email,
    phone: body.phone,
    companyName: body.companyName,
    units: body.units,
    monthlyVolume: body.monthlyVolume,
    message: body.message,
  };
}

/**
 * Detalhes do 400 com mensagens FIXAS por campo (nunca a mensagem do Zod, que poderia citar o valor ou o nome
 * de um campo desconhecido). Um item por campo, na ordem do formulário.
 */
export function salesContactErrorDetails(
  error: z.ZodError,
): { readonly path: string; readonly message: string }[] {
  const seen = new Set<string>();
  const details: { path: string; message: string }[] = [];
  for (const issue of error.issues) {
    const field = issue.code === 'unrecognized_keys' ? undefined : String(issue.path[0] ?? '');
    const known =
      field !== undefined && field in SALES_CONTACT_FIELD_MESSAGES && field !== 'unknown'
        ? (field as SalesContactField)
        : undefined;
    const path = known ?? '';
    if (seen.has(path)) continue;
    seen.add(path);
    details.push({
      path,
      message:
        known === undefined
          ? SALES_CONTACT_FIELD_MESSAGES.unknown
          : SALES_CONTACT_FIELD_MESSAGES[known],
    });
  }
  return details;
}
