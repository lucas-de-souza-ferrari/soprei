import { z } from 'zod';
import { ApiError, request } from '../api';

/**
 * Agenda da empresa (spec 027): contratos estritos e mensagens por `status` e `error.code`. O texto de
 * erro do servidor nunca é lido nem exibido. Serviço, rótulo do agendamento, contato e horários vivem só em
 * memória: nada vai a URL, armazenamento do navegador, título da página nem log. **O navegador não
 * calcula fuso:** datas e horas vêm prontas do servidor (`localDate`, `localStart`, `localEnd`).
 */
const isoDate = z.iso.datetime();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^\d{2}:\d{2}$/);

export const settingsSchema = z.strictObject({
  timezone: z.string().min(1).max(64),
  today: localDate,
  slotStepMinutes: z.number().int(),
  minNoticeMinutes: z.number().int().min(0),
  maxAdvanceDays: z.number().int().min(1),
  /** Spec 028: a IA pode solicitar, cancelar e remarcar horários; confirmar automaticamente. */
  aiBookingEnabled: z.boolean(),
  aiAutoConfirm: z.boolean(),
});
export type AgendaSettings = z.infer<typeof settingsSchema>;

export const windowSchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  start: localTime,
  end: localTime,
});
export type AgendaWindow = z.infer<typeof windowSchema>;

export const resourceSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  active: z.boolean(),
  position: z.number().int(),
  windows: z.array(windowSchema).max(100),
});
export type AgendaResource = z.infer<typeof resourceSchema>;
export const resourcesSchema = z.strictObject({ items: z.array(resourceSchema).max(100) });

export const serviceSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  durationMinutes: z.number().int(),
  bufferMinutes: z.number().int(),
  active: z.boolean(),
  isSample: z.boolean(),
});
export type AgendaService = z.infer<typeof serviceSchema>;
export const servicesSchema = z.strictObject({ items: z.array(serviceSchema).max(200) });

export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Sem `contactRef`: se o servidor voltar a mandá-lo, a leitura falha em vez de exibir. */
export const appointmentSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['BOOKING', 'BLOCK']),
  status: z.enum(APPOINTMENT_STATUSES),
  source: z.enum(['PANEL', 'CHANNEL']),
  resourceId: z.uuid(),
  resourceName: z.string().nullable(),
  serviceId: z.uuid().nullable(),
  serviceName: z.string().nullable(),
  startsAt: isoDate,
  endsAt: isoDate,
  localDate,
  localStart: localTime,
  localEnd: localTime,
  weekday: z.number().int().min(1).max(7),
  customerLabel: z.string().nullable(),
  /** Spec 028: `CONTACT` = o próprio contato cancelou (pela IA). */
  cancelledBy: z.enum(['PANEL', 'CONTACT']).nullable(),
  contactLabel: z.string().nullable(),
  createdAt: isoDate,
});
export type Appointment = z.infer<typeof appointmentSchema>;

export const appointmentsSchema = z.strictObject({
  timezone: z.string(),
  today: localDate,
  items: z.array(appointmentSchema).max(500),
});

export const slotSchema = z.strictObject({
  resourceId: z.uuid(),
  startsAt: isoDate,
  endsAt: isoDate,
  localDate,
  localStart: localTime,
  localEnd: localTime,
  weekday: z.number().int().min(1).max(7),
});
export type Slot = z.infer<typeof slotSchema>;

export const availabilitySchema = z.strictObject({
  timezone: z.string(),
  generatedAt: isoDate,
  slots: z.array(slotSchema).max(2_000),
});

export const blocksSchema = z.strictObject({ items: z.array(appointmentSchema).max(20) });

export interface SettingsInput {
  readonly timezone: string;
  readonly slotStepMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
  readonly aiBookingEnabled?: boolean;
  readonly aiAutoConfirm?: boolean;
}

export interface AppointmentQuery {
  readonly from: string;
  readonly to: string;
  readonly resourceId?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly status?: AppointmentStatus | undefined;
}

const base = (companyId: string): string => `/admin/companies/${companyId}/schedule`;
const part = (id: string): string => encodeURIComponent(id);

function queryOf(params: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

export const agendaApi = {
  settings: async (companyId: string) =>
    settingsSchema.parse(await request(`${base(companyId)}/settings`)),
  saveSettings: async (companyId: string, body: SettingsInput) =>
    settingsSchema.parse(await request(`${base(companyId)}/settings`, { method: 'PUT', body })),
  resources: async (companyId: string) =>
    resourcesSchema.parse(await request(`${base(companyId)}/resources`)).items,
  createResource: async (companyId: string, name: string) =>
    resourceSchema.parse(
      await request(`${base(companyId)}/resources`, { method: 'POST', body: { name } }),
    ),
  patchResource: async (
    companyId: string,
    resourceId: string,
    body: { name?: string; active?: boolean },
  ) =>
    resourceSchema.parse(
      await request(`${base(companyId)}/resources/${part(resourceId)}`, { method: 'PATCH', body }),
    ),
  saveRules: async (companyId: string, resourceId: string, windows: readonly AgendaWindow[]) =>
    resourceSchema.parse(
      await request(`${base(companyId)}/resources/${part(resourceId)}/rules`, {
        method: 'PUT',
        body: { windows },
      }),
    ),
  services: async (companyId: string) =>
    servicesSchema.parse(await request(`${base(companyId)}/services`)).items,
  createService: async (
    companyId: string,
    body: { name: string; durationMinutes: number; bufferMinutes: number },
  ) => serviceSchema.parse(await request(`${base(companyId)}/services`, { method: 'POST', body })),
  patchService: async (
    companyId: string,
    serviceId: string,
    body: { name?: string; durationMinutes?: number; bufferMinutes?: number; active?: boolean },
  ) =>
    serviceSchema.parse(
      await request(`${base(companyId)}/services/${part(serviceId)}`, { method: 'PATCH', body }),
    ),
  availability: async (
    companyId: string,
    query: { serviceId: string; resourceId?: string | undefined; from: string; to: string },
  ) =>
    availabilitySchema.parse(
      await request(
        `${base(companyId)}/availability${queryOf({
          serviceId: query.serviceId,
          resourceId: query.resourceId,
          from: query.from,
          to: query.to,
        })}`,
      ),
    ),
  appointments: async (companyId: string, query: AppointmentQuery) =>
    appointmentsSchema.parse(
      await request(
        `${base(companyId)}/appointments${queryOf({
          from: query.from,
          to: query.to,
          resourceId: query.resourceId,
          serviceId: query.serviceId,
          status: query.status,
        })}`,
      ),
    ),
  createAppointment: async (
    companyId: string,
    body: {
      serviceId: string;
      resourceId: string;
      localStart: string;
      customerLabel?: string;
      status?: 'PENDING' | 'CONFIRMED';
    },
  ) =>
    appointmentSchema.parse(
      await request(`${base(companyId)}/appointments`, { method: 'POST', body }),
    ),
  patchAppointment: async (
    companyId: string,
    appointmentId: string,
    body:
      | { status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' }
      | { localStart: string }
      | { customerLabel: string | null },
  ) =>
    appointmentSchema.parse(
      await request(`${base(companyId)}/appointments/${part(appointmentId)}`, {
        method: 'PATCH',
        body,
      }),
    ),
  createBlocks: async (
    companyId: string,
    body: { resourceIds: readonly string[]; localStart: string; localEnd: string },
  ) => blocksSchema.parse(await request(`${base(companyId)}/blocks`, { method: 'POST', body })),
  loadSample: async (companyId: string) =>
    sampleLoadSchema.parse(await request(`${base(companyId)}/sample`, { method: 'POST' })),
  removeSample: async (companyId: string) =>
    sampleRemoveSchema.parse(await request(`${base(companyId)}/sample`, { method: 'DELETE' })),
  deleteBlock: async (companyId: string, blockId: string): Promise<void> => {
    await request(`${base(companyId)}/blocks/${part(blockId)}`, { method: 'DELETE' });
  },
};

export const sampleLoadSchema = z.strictObject({ created: z.boolean() });
export const sampleRemoveSchema = z.strictObject({ services: z.number().int().min(0) });

export const SLOT_TAKEN_MESSAGE = 'Esse horário acabou de ser ocupado; escolha outro.';
export const AGENDA_INVALID_MESSAGE = 'Confira os campos e tente de novo.';
export const AGENDA_STALE_MESSAGE = 'Este item não existe mais. A agenda foi atualizada.';

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  SLOT_TAKEN: SLOT_TAKEN_MESSAGE,
  IN_THE_PAST: 'Esse horário já passou. Escolha um horário futuro.',
  RESOURCE_HAS_APPOINTMENTS:
    'Este recurso tem agendamentos futuros. Cancele ou remarque-os antes de desativar.',
  INVALID_TRANSITION: 'Este agendamento não pode mudar para esse estado agora.',
  SERVICE_INACTIVE: 'Este serviço está desativado.',
  RESOURCE_INACTIVE: 'Este recurso está desativado.',
  SCHEDULE_LIMIT_REACHED: 'Limite da agenda atingido.',
  RANGE_TOO_LARGE: 'Período grande demais. Escolha um intervalo menor.',
  INVALID_TIMEZONE: 'Fuso horário inválido. Use um nome como America/Sao_Paulo.',
  INVALID_WINDOWS: 'Os horários do mesmo dia não podem se sobrepor.',
  INVALID_LOCAL_TIME: 'Esse horário não existe nessa data (mudança de horário de verão).',
  INVALID_RANGE: 'O fim deve ser depois do início.',
  INVALID_AI_SETTINGS: 'Confirmar automaticamente exige a IA ligada.',
  SAMPLE_REQUIRES_EMPTY: 'O exemplo só carrega em uma agenda sem serviços seus.',
};

/**
 * Mensagem própria da agenda para uma falha, ou `null` quando ela é de outro tipo (sessão, empresa
 * trocada, permissão, indisponível), que a área da empresa trata em `settle`.
 */
export function agendaMessageOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const known = error.code === undefined ? undefined : CODE_MESSAGES[error.code];
  if (known !== undefined) return known;
  if (error.status === 400) return AGENDA_INVALID_MESSAGE;
  return null;
}

/** O conflito de horário recarrega os horários livres (nunca "erro genérico"). */
export function isSlotTaken(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'SLOT_TAKEN';
}
