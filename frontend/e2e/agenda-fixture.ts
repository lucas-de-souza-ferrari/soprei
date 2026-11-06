import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SENTINEL, type Call, type FakeApi } from './company-fixture';

export interface FakeAppointment {
  id: string;
  kind: 'BOOKING' | 'BLOCK';
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  source: 'PANEL' | 'CHANNEL';
  resourceId: string;
  resourceName: string;
  serviceId: string | null;
  serviceName: string | null;
  startsAt: string;
  endsAt: string;
  localDate: string;
  localStart: string;
  localEnd: string;
  weekday: number;
  customerLabel: string | null;
  cancelledBy: 'PANEL' | 'CONTACT' | null;
  contactLabel: string | null;
  createdAt: string;
}

/** Estado da API falsa da agenda (spec 027): camada por cima da API falsa da área da empresa. */
export interface FakeAgenda {
  today: string;
  timezone: string;
  resourceId: string;
  serviceId: string;
  appointments: FakeAppointment[];
  /** O próximo `POST` de agendamento responde 409 `SLOT_TAKEN` (e a flag desliga). */
  takeNext: boolean;
  /** Chamadas às rotas da agenda. */
  calls: Call[];
  availabilityReads: number;
  /** Agenda sem serviço (o exemplo ainda não foi carregado). */
  noServices: boolean;
  /** O serviço que existe é o de exemplo. */
  sample: boolean;
  /** Opções da IA (spec 028). */
  aiBookingEnabled: boolean;
  aiAutoConfirm: boolean;
}

export function newAgenda(): FakeAgenda {
  return {
    today: '2026-11-09',
    timezone: 'America/Sao_Paulo',
    resourceId: randomUUID(),
    serviceId: randomUUID(),
    appointments: [],
    takeNext: false,
    calls: [],
    availabilityReads: 0,
    noServices: false,
    sample: false,
    aiBookingEnabled: false,
    aiAutoConfirm: false,
  };
}

/** Horário em minutos: `HH:mm` -> instante falso (o navegador nunca o converte; só mostra `local*`). */
export function appointment(
  agenda: FakeAgenda,
  localDate: string,
  localStart: string,
  localEnd: string,
  extra: Partial<FakeAppointment> = {},
): FakeAppointment {
  const [y, m, d] = localDate.split('-').map(Number);
  const [h, min] = localStart.split(':').map(Number);
  const [eh, emin] = localEnd.split(':').map(Number);
  const start = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, (h ?? 0) + 3, min ?? 0));
  const end = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, (eh ?? 0) + 3, emin ?? 0));
  const weekday = ((new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1)).getUTCDay() + 6) % 7) + 1;
  return {
    id: randomUUID(),
    kind: 'BOOKING',
    status: 'CONFIRMED',
    source: 'PANEL',
    resourceId: agenda.resourceId,
    resourceName: 'Agenda principal',
    serviceId: agenda.serviceId,
    serviceName: 'Corte de cabelo',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    localDate,
    localStart,
    localEnd,
    weekday,
    customerLabel: 'João',
    cancelledBy: null,
    contactLabel: null,
    createdAt: '2026-11-09T11:00:00.000Z',
    ...extra,
  };
}

/**
 * Instala as rotas da agenda por cima da API falsa da empresa (`page.route` registrado depois vale
 * primeiro; o resto segue por `route.fallback()`).
 */
export async function installAgendaApi(
  page: Page,
  api: FakeApi,
  agenda: FakeAgenda,
  role: 'OWNER' | 'AGENT' | 'VIEWER',
): Promise<void> {
  const permissions = {
    OWNER: ['conversation:read', 'schedule:read', 'schedule:manage', 'schedule:configure'],
    AGENT: ['conversation:read', 'schedule:read', 'schedule:manage'],
    VIEWER: ['conversation:read', 'schedule:read'],
  }[role];
  const current = api.companies[0];
  if (current !== undefined) current.permissions = permissions;
  const settings = (): object => ({
    timezone: agenda.timezone,
    today: agenda.today,
    slotStepMinutes: 30,
    minNoticeMinutes: 120,
    maxAdvanceDays: 60,
    aiBookingEnabled: agenda.aiBookingEnabled,
    aiAutoConfirm: agenda.aiAutoConfirm,
  });
  await page.route('**/api/admin/companies/*/schedule/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/admin\/companies\/[^/]+\/schedule/, '');
    const method = request.method();
    const body: unknown = method === 'GET' ? undefined : (request.postDataJSON() as unknown);
    agenda.calls.push({ method, path, body });
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    const fail = (status: number, code: string) =>
      reply(status, { error: { code, message: SENTINEL, requestId: 'x' } });

    if (path === '/settings' && method === 'GET') return reply(200, settings());
    if (path === '/settings' && method === 'PUT') {
      const input = body as {
        timezone: string;
        aiBookingEnabled?: boolean;
        aiAutoConfirm?: boolean;
      };
      agenda.timezone = input.timezone;
      if (input.aiBookingEnabled !== undefined) agenda.aiBookingEnabled = input.aiBookingEnabled;
      if (input.aiAutoConfirm !== undefined) agenda.aiAutoConfirm = input.aiAutoConfirm;
      if (!agenda.aiBookingEnabled) agenda.aiAutoConfirm = false;
      return reply(200, settings());
    }
    if (path === '/resources' && method === 'GET') {
      return reply(200, {
        items: [
          {
            id: agenda.resourceId,
            name: 'Agenda principal',
            active: true,
            position: 0,
            windows: [{ weekday: 1, start: '09:00', end: '18:00' }],
          },
        ],
      });
    }
    if (path === '/sample' && method === 'POST') {
      agenda.noServices = false;
      agenda.sample = true;
      return reply(201, { created: true });
    }
    if (path === '/sample' && method === 'DELETE') {
      agenda.noServices = true;
      agenda.sample = false;
      return reply(200, { services: 1 });
    }
    if (path === '/services' && method === 'GET') {
      if (agenda.noServices) return reply(200, { items: [] });
      return reply(200, {
        items: [
          {
            id: agenda.serviceId,
            name: 'Corte de cabelo',
            durationMinutes: 30,
            bufferMinutes: 0,
            active: true,
            isSample: agenda.sample,
          },
        ],
      });
    }
    if (path === '/availability') {
      agenda.availabilityReads += 1;
      const date = url.searchParams.get('from') ?? agenda.today;
      const slots = ['09:00', '09:30', '10:00'].map((time) => ({
        resourceId: agenda.resourceId,
        startsAt: `${date}T12:00:00.000Z`,
        endsAt: `${date}T12:30:00.000Z`,
        localDate: date,
        localStart: time,
        localEnd: time,
        weekday: 1,
      }));
      return reply(200, {
        timezone: agenda.timezone,
        generatedAt: new Date().toISOString(),
        slots,
      });
    }
    if (path === '/appointments' && method === 'GET') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const status = url.searchParams.get('status');
      const items = agenda.appointments
        .filter((item) => item.localDate >= from && item.localDate <= to)
        .filter((item) => status === null || item.status === status)
        .sort((a, b) => (a.localDate + a.localStart).localeCompare(b.localDate + b.localStart));
      return reply(200, { timezone: agenda.timezone, today: agenda.today, items });
    }
    if (path === '/appointments' && method === 'POST') {
      if (agenda.takeNext) {
        agenda.takeNext = false;
        return fail(409, 'SLOT_TAKEN');
      }
      const input = body as { localStart: string; customerLabel?: string };
      const [date = '', time = '00:00'] = input.localStart.split('T');
      const created = appointment(agenda, date, time, time, {
        customerLabel: input.customerLabel ?? null,
      });
      agenda.appointments.push(created);
      return reply(201, created);
    }
    const one = /^\/appointments\/([^/]+)$/.exec(path);
    if (one !== null && method === 'PATCH') {
      const found = agenda.appointments.find((item) => item.id === one[1]);
      if (found === undefined) return fail(404, 'NOT_FOUND');
      const change = body as { status?: FakeAppointment['status']; localStart?: string };
      if (change.status !== undefined) {
        found.status = change.status;
        if (change.status === 'CANCELLED') found.cancelledBy = 'PANEL';
      }
      if (change.localStart !== undefined) {
        const [date = '', time = '00:00'] = change.localStart.split('T');
        found.localDate = date;
        found.localStart = time;
        found.localEnd = time;
      }
      return reply(200, found);
    }
    const blockOne = /^\/blocks\/([^/]+)$/.exec(path);
    if (blockOne !== null && method === 'DELETE') {
      const index = agenda.appointments.findIndex(
        (item) => item.id === blockOne[1] && item.kind === 'BLOCK',
      );
      if (index < 0) return fail(404, 'NOT_FOUND');
      agenda.appointments.splice(index, 1);
      return reply(204);
    }
    if (path === '/blocks' && method === 'POST') {
      const input = body as { resourceIds: string[]; localStart: string; localEnd: string };
      const [date = '', start = '00:00'] = input.localStart.split('T');
      const [, end = '00:00'] = input.localEnd.split('T');
      const items = input.resourceIds.map(() =>
        appointment(agenda, date, start, end, {
          kind: 'BLOCK',
          serviceId: null,
          serviceName: null,
          customerLabel: null,
        }),
      );
      agenda.appointments.push(...items);
      return reply(201, { items });
    }
    return fail(404, 'NOT_FOUND');
  });
}
