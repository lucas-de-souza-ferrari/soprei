import { z } from 'zod';

const digits = z.string().regex(/^[0-9]{1,32}$/, 'de 1 a 32 dígitos');

/**
 * Corpo do `POST .../channel/embedded-signup` (spec 015b). Estrito. O `code` (uso único, ~30 s) vem
 * do navegador; as mensagens do Zod nunca o ecoam. Os ids do navegador não são confiados: o servidor
 * os revalida na Graph com o token obtido do `code`.
 */
export const embeddedSignupBodySchema = z
  .object({
    code: z
      .string()
      .min(1, 'de 1 a 512 caracteres, sem espaço nem controle')
      .max(512, 'de 1 a 512 caracteres, sem espaço nem controle')
      .regex(/^[^\s\p{Cc}]+$/u, 'de 1 a 512 caracteres, sem espaço nem controle'),
    wabaId: digits,
    phoneNumberId: digits,
  })
  .strict();

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
