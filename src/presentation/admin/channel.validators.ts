import { z } from 'zod';

const digits = z.string().regex(/^[0-9]{1,32}$/, 'de 1 a 32 dígitos');

/**
 * Corpo do `PUT .../channel` (spec 015). Estrito. As mensagens do Zod não ecoam o valor recebido:
 * o `accessToken` nunca aparece em erro, log nem resposta.
 */
export const putChannelBodySchema = z
  .object({
    phoneNumberId: digits,
    wabaId: digits,
    accessToken: z
      .string()
      .min(20, 'de 20 a 1024 caracteres, sem espaço nem controle')
      .max(1024, 'de 20 a 1024 caracteres, sem espaço nem controle')
      .regex(/^[^\s\p{Cc}]+$/u, 'de 20 a 1024 caracteres, sem espaço nem controle'),
  })
  .strict();
