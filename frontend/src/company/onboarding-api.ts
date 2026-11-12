import { z } from 'zod';
import { request } from '../api';
import type { OnboardingState } from './onboarding-steps';

/**
 * Estado do assistente de primeiros passos (spec 030): só booleanos, contrato estrito (campo desconhecido
 * é recusado). Mensagens de erro vêm do `status` e do `error.code`, nunca do texto do servidor.
 */
export const onboardingSchema = z.strictObject({
  dismissed: z.boolean(),
  steps: z.strictObject({
    persona: z.boolean().optional(),
    knowledge: z.boolean().optional(),
    schedule: z.boolean().optional(),
    inventory: z.boolean().optional(),
  }),
});

const path = (companyId: string): string => `/admin/companies/${companyId}/onboarding`;

export const onboardingApi = {
  get: async (companyId: string): Promise<OnboardingState> =>
    onboardingSchema.parse(await request(path(companyId))),
  setDismissed: async (companyId: string, dismissed: boolean): Promise<OnboardingState> =>
    onboardingSchema.parse(await request(path(companyId), { method: 'PUT', body: { dismissed } })),
};
