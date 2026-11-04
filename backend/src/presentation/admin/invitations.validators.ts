import { z } from 'zod';
import { emailSchema } from '../../application/auth/credentials.js';
import { INVITABLE_ROLES } from '../../domain/index.js';

/**
 * Corpo de `POST /admin/companies/:companyId/invitations` (spec 025). `strict`; o papel só pode ser
 * `ADMIN`, `AGENT` ou `VIEWER` (`OWNER` é 400). As mensagens de erro do Zod trazem só o caminho e o
 * motivo, nunca o valor recebido (o e-mail não volta nem vai ao log).
 */
export const createInvitationBodySchema = z
  .object({
    email: emailSchema,
    role: z.enum(INVITABLE_ROLES),
  })
  .strict();
