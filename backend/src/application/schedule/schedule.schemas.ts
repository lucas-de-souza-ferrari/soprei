import { z } from 'zod';
import {
  SCHEDULE_BLOCK_MAX_RESOURCES,
  SCHEDULE_CUSTOMER_LABEL_MAX_LENGTH,
  SCHEDULE_MAX_ADVANCE_DAYS,
  SCHEDULE_MAX_MIN_NOTICE_MINUTES,
  SCHEDULE_MAX_WINDOWS_PER_DAY,
  SCHEDULE_NAME_MAX_LENGTH,
  SCHEDULE_SERVICE_BUFFER_MAX,
  SCHEDULE_SERVICE_DURATION_MAX,
  SCHEDULE_SERVICE_DURATION_MIN,
  SCHEDULE_SLOT_STEPS,
} from '../../domain/index.js';
import { isValidLocalDate } from './zoned-time.js';

/** Sem caracteres de controle (inclui NUL): nomes e rótulos são texto de uma linha. */
const CONTROL = /\p{Cc}/u;
const oneLine = (value: string): boolean => !CONTROL.test(value);

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SCHEDULE_NAME_MAX_LENGTH)
  .refine(oneLine, 'sem caracteres de controle');

/** Só nome: de 1 a 60 caracteres, uma linha. Nunca motivo de consulta nem dado de saúde. */
export const customerLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(SCHEDULE_CUSTOMER_LABEL_MAX_LENGTH)
  .refine(oneLine, 'sem caracteres de controle');

const slotStepSchema = z
  .number()
  .int()
  .refine((value) => (SCHEDULE_SLOT_STEPS as readonly number[]).includes(value), 'passo inválido');

/** `PUT .../schedule/settings`: o corpo é o objeto inteiro. O fuso é conferido pelo serviço (`INVALID_TIMEZONE`). */
export const settingsBodySchema = z
  .object({
    timezone: z.string().trim().min(1).max(64),
    slotStepMinutes: slotStepSchema,
    minNoticeMinutes: z.number().int().min(0).max(SCHEDULE_MAX_MIN_NOTICE_MINUTES),
    maxAdvanceDays: z.number().int().min(1).max(SCHEDULE_MAX_ADVANCE_DAYS),
    /** Spec 028: opcionais (omitido = não muda). `aiAutoConfirm` exige a IA ligada. */
    aiBookingEnabled: z.boolean().optional(),
    aiAutoConfirm: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.aiAutoConfirm === true && value.aiBookingEnabled === false), {
    message: 'confirmar automaticamente exige a IA ligada',
    path: ['aiAutoConfirm'],
  });
export type SettingsBody = z.infer<typeof settingsBodySchema>;

export const resourceInputSchema = z.object({ name: nameSchema }).strict();
export type ResourceInput = z.infer<typeof resourceInputSchema>;

export const resourcePatchSchema = z
  .object({
    name: nameSchema.optional(),
    active: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'informe ao menos um campo');
export type ResourcePatch = z.infer<typeof resourcePatchSchema>;

const durationSchema = z
  .number()
  .int()
  .min(SCHEDULE_SERVICE_DURATION_MIN)
  .max(SCHEDULE_SERVICE_DURATION_MAX)
  .refine((value) => value % 5 === 0, 'deve ser múltiplo de 5');
const bufferSchema = z.number().int().min(0).max(SCHEDULE_SERVICE_BUFFER_MAX);

export const serviceInputSchema = z
  .object({
    name: nameSchema,
    durationMinutes: durationSchema,
    bufferMinutes: bufferSchema.default(0),
  })
  .strict();
export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const servicePatchSchema = z
  .object({
    name: nameSchema.optional(),
    durationMinutes: durationSchema.optional(),
    bufferMinutes: bufferSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'informe ao menos um campo');
export type ServicePatch = z.infer<typeof servicePatchSchema>;

/** `HH:mm` (00:00 a 23:59; `24:00` só como fim) em minutos desde a meia-noite. */
const timeOfDaySchema = z.string().transform((value, ctx) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = match === null ? NaN : Number(match[1]);
  const minute = match === null ? NaN : Number(match[2]);
  const valid =
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    minute <= 59 &&
    (hour <= 23 || (hour === 24 && minute === 0));
  if (!valid) {
    ctx.addIssue({ code: 'custom', message: 'horário inválido (HH:mm)' });
    return z.NEVER;
  }
  return hour * 60 + minute;
});

const windowSchema = z
  .object({ weekday: z.number().int().min(1).max(7), start: timeOfDaySchema, end: timeOfDaySchema })
  .strict()
  .refine((value) => value.start < value.end, 'o fim deve ser depois do início');

/** `PUT .../resources/:resourceId/rules`: substitui o conjunto. Sobreposição é conferida em `parseWindows`. */
export const rulesBodySchema = z
  .object({ windows: z.array(windowSchema).max(7 * SCHEDULE_MAX_WINDOWS_PER_DAY) })
  .strict();

const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidLocalDate, 'data inválida');

const idSchema = z.string().min(1).max(64);

export const availabilityQuerySchema = z
  .object({
    serviceId: idSchema,
    resourceId: idSchema.optional(),
    from: localDateSchema,
    to: localDateSchema,
  })
  .strict();
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const appointmentsQuerySchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
    resourceId: idSchema.optional(),
    serviceId: idSchema.optional(),
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']).optional(),
  })
  .strict();
export type AppointmentsQuery = z.infer<typeof appointmentsQuerySchema>;

/** ISO 8601 **com** `Z` ou deslocamento (sem deslocamento é 400: o servidor não adivinha o fuso). */
const instantSchema = z.iso.datetime({ offset: true });
const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

const createFields = {
  serviceId: idSchema,
  resourceId: idSchema,
  startsAt: instantSchema.optional(),
  localStart: localDateTimeSchema.optional(),
  customerLabel: customerLabelSchema.optional(),
  status: z.enum(['PENDING', 'CONFIRMED']).optional(),
};

/** Exatamente um de `startsAt` (instante) e `localStart` (relógio da empresa). */
export const createAppointmentSchema = z
  .object(createFields)
  .strict()
  .refine((value) => (value.startsAt === undefined) !== (value.localStart === undefined), {
    message: 'informe startsAt ou localStart',
  });
export type CreateAppointmentBody = z.infer<typeof createAppointmentSchema>;

/** Um só tipo de mudança por chamada: `status`, remarcar (`startsAt`|`localStart`) ou `customerLabel`. */
export const patchAppointmentSchema = z
  .object({
    status: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']).optional(),
    startsAt: instantSchema.optional(),
    localStart: localDateTimeSchema.optional(),
    customerLabel: customerLabelSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kinds =
      Number(value.status !== undefined) +
      Number(value.startsAt !== undefined || value.localStart !== undefined) +
      Number(value.customerLabel !== undefined);
    if (kinds !== 1 || (value.startsAt !== undefined && value.localStart !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'informe um só tipo de mudança' });
    }
  });
export type PatchAppointmentBody = z.infer<typeof patchAppointmentSchema>;

export const createBlocksSchema = z
  .object({
    resourceIds: z.array(idSchema).min(1).max(SCHEDULE_BLOCK_MAX_RESOURCES),
    startsAt: instantSchema.optional(),
    endsAt: instantSchema.optional(),
    localStart: localDateTimeSchema.optional(),
    localEnd: localDateTimeSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.startsAt !== undefined &&
        value.endsAt !== undefined &&
        value.localStart === undefined &&
        value.localEnd === undefined) ||
      (value.localStart !== undefined &&
        value.localEnd !== undefined &&
        value.startsAt === undefined &&
        value.endsAt === undefined),
    { message: 'informe startsAt e endsAt, ou localStart e localEnd' },
  );
export type CreateBlocksBody = z.infer<typeof createBlocksSchema>;
