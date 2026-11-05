import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../../application/auth/auth.service.js';
import type {
  AppointmentView,
  ResourceView,
  ScheduleService,
  SlotView,
} from '../../application/schedule/schedule.service.js';
import {
  appointmentsQuerySchema,
  availabilityQuerySchema,
  createAppointmentSchema,
  createBlocksSchema,
  patchAppointmentSchema,
  resourceInputSchema,
  resourcePatchSchema,
  rulesBodySchema,
  serviceInputSchema,
  servicePatchSchema,
  settingsBodySchema,
} from '../../application/schedule/schedule.schemas.js';
import type {
  ScheduleResource,
  ScheduleServiceItem,
  ScheduleSettings,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, membershipAuth, requirePermission } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { companyIdSchema } from './company.validators.js';

export interface AdminScheduleControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly schedule: Pick<
    ScheduleService,
    | 'getSettings'
    | 'updateSettings'
    | 'listResources'
    | 'createResource'
    | 'updateResource'
    | 'setRules'
    | 'listServices'
    | 'createService'
    | 'updateService'
    | 'availability'
    | 'listAppointments'
    | 'createAppointment'
    | 'updateAppointment'
    | 'createBlocks'
    | 'cancelBlock'
    | 'view'
    | 'viewMany'
  >;
}

/** Ids que não são UUID, inexistentes e de outra empresa são o mesmo 404 (o repositório decide). */
const resourceParams = z.object({ companyId: companyIdSchema, resourceId: z.string() });
const serviceParams = z.object({ companyId: companyIdSchema, serviceId: z.string() });
const appointmentParams = z.object({ companyId: companyIdSchema, appointmentId: z.string() });
const blockParams = z.object({ companyId: companyIdSchema, blockId: z.string() });

function toSettingsResponse(settings: ScheduleSettings & { readonly today: string }): {
  timezone: string;
  today: string;
  slotStepMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
} {
  return {
    timezone: settings.timezone,
    today: settings.today,
    slotStepMinutes: settings.slotStepMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxAdvanceDays: settings.maxAdvanceDays,
  };
}

const toResourceResponse = (
  resource: ScheduleResource | ResourceView,
): {
  id: string;
  name: string;
  active: boolean;
  position: number;
  windows: readonly { weekday: number; start: string; end: string }[];
} => ({
  id: resource.id,
  name: resource.name,
  active: resource.active,
  position: resource.position,
  windows: 'windows' in resource ? resource.windows : [],
});

const toServiceResponse = (
  service: ScheduleServiceItem,
): {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  active: boolean;
  isSample: boolean;
} => ({
  id: service.id,
  name: service.name,
  durationMinutes: service.durationMinutes,
  bufferMinutes: service.bufferMinutes,
  active: service.active,
  isSample: service.isSample,
});

/** Agendamento para o navegador: campos `local*` já calculados no servidor; **nunca** `contactRef`. */
function toAppointmentResponse(view: AppointmentView): Record<string, unknown> {
  return {
    id: view.id,
    kind: view.kind,
    status: view.status,
    source: view.source,
    resourceId: view.resourceId,
    resourceName: view.resourceName,
    serviceId: view.serviceId,
    serviceName: view.serviceName,
    startsAt: view.startsAt.toISOString(),
    endsAt: view.endsAt.toISOString(),
    localDate: view.localDate,
    localStart: view.localStart,
    localEnd: view.localEnd,
    weekday: view.weekday,
    customerLabel: view.customerLabel,
    contactLabel: view.contactLabel,
    createdAt: view.createdAt.toISOString(),
  };
}

const toSlotResponse = (slot: SlotView): Record<string, unknown> => ({
  resourceId: slot.resourceId,
  startsAt: slot.startsAt.toISOString(),
  endsAt: slot.endsAt.toISOString(),
  localDate: slot.localDate,
  localStart: slot.localStart,
  localEnd: slot.localEnd,
  weekday: slot.weekday,
});

/**
 * Agenda da própria empresa (spec 027). Registre com `prefix: '/admin/companies'`. O `:companyId` do
 * caminho é conferido contra a identidade pelo `requirePermission` (404 antes de 403) e descartado: o
 * service recebe só o `CompanyId` da identidade. Nome de serviço, rótulo do agendamento, contato e horários
 * **nunca** vão a log nem a métrica (só ids e a ação). O corpo de erro de validação não ecoa o valor.
 */
export const adminScheduleController: FastifyPluginCallback<AdminScheduleControllerOptions> = (
  app,
  { auth, metrics, schedule },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const gate = (permission: 'schedule:read' | 'schedule:manage' | 'schedule:configure') => ({
    config,
    onRequest: requirePermission(permission, { companyParam: 'companyId', metrics }),
  });
  const read = gate('schedule:read');
  const manage = gate('schedule:manage');
  const configure = gate('schedule:configure');
  const base = '/:companyId/schedule';

  app.get(`${base}/settings`, read, async (request) => {
    const { companyId } = membershipAuth(request);
    return toSettingsResponse(await schedule.getSettings(companyId));
  });

  app.put(`${base}/settings`, configure, async (request) => {
    const { companyId } = membershipAuth(request);
    const body = settingsBodySchema.parse(request.body);
    return toSettingsResponse(await schedule.updateSettings(companyId, body));
  });

  app.get(`${base}/resources`, read, async (request) => {
    const { companyId } = membershipAuth(request);
    return { items: (await schedule.listResources(companyId)).map(toResourceResponse) };
  });

  app.post(`${base}/resources`, configure, async (request, reply) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = resourceInputSchema.parse(request.body);
    const resource = await schedule.createResource(companyId, body);
    request.log.info(
      { companyId, membershipId, resourceId: resource.id },
      'recurso da agenda criado',
    );
    return reply.status(201).send(toResourceResponse(resource));
  });

  app.patch(`${base}/resources/:resourceId`, configure, async (request) => {
    const { resourceId } = resourceParams.parse(request.params);
    const { companyId, membershipId } = membershipAuth(request);
    const body = resourcePatchSchema.parse(request.body);
    const resource = await schedule.updateResource(companyId, resourceId, body);
    request.log.info({ companyId, membershipId, resourceId }, 'recurso da agenda atualizado');
    return toResourceResponse(resource);
  });

  app.put(`${base}/resources/:resourceId/rules`, configure, async (request) => {
    const { resourceId } = resourceParams.parse(request.params);
    const { companyId, membershipId } = membershipAuth(request);
    const body = rulesBodySchema.parse(request.body);
    const resource = await schedule.setRules(companyId, resourceId, body.windows);
    request.log.info({ companyId, membershipId, resourceId }, 'horários do recurso atualizados');
    return toResourceResponse(resource);
  });

  app.get(`${base}/services`, read, async (request) => {
    const { companyId } = membershipAuth(request);
    return { items: (await schedule.listServices(companyId)).map(toServiceResponse) };
  });

  app.post(`${base}/services`, configure, async (request, reply) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = serviceInputSchema.parse(request.body);
    const service = await schedule.createService(companyId, body);
    request.log.info(
      { companyId, membershipId, serviceId: service.id },
      'serviço da agenda criado',
    );
    return reply.status(201).send(toServiceResponse(service));
  });

  app.patch(`${base}/services/:serviceId`, configure, async (request) => {
    const { serviceId } = serviceParams.parse(request.params);
    const { companyId, membershipId } = membershipAuth(request);
    const body = servicePatchSchema.parse(request.body);
    const service = await schedule.updateService(companyId, serviceId, body);
    request.log.info({ companyId, membershipId, serviceId }, 'serviço da agenda atualizado');
    return toServiceResponse(service);
  });

  app.get(`${base}/availability`, read, async (request) => {
    const { companyId } = membershipAuth(request);
    const query = availabilityQuerySchema.parse(request.query);
    const result = await schedule.availability(companyId, query);
    return {
      timezone: result.timezone,
      generatedAt: result.generatedAt.toISOString(),
      slots: result.slots.map(toSlotResponse),
    };
  });

  app.get(`${base}/appointments`, read, async (request) => {
    const { companyId } = membershipAuth(request);
    const query = appointmentsQuerySchema.parse(request.query);
    const result = await schedule.listAppointments(companyId, query);
    return {
      timezone: result.timezone,
      today: result.today,
      items: result.items.map(toAppointmentResponse),
    };
  });

  app.post(`${base}/appointments`, manage, async (request, reply) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = createAppointmentSchema.parse(request.body);
    const created = await schedule.createAppointment(companyId, membershipId, body);
    return reply.status(201).send(toAppointmentResponse(await schedule.view(companyId, created)));
  });

  app.patch(`${base}/appointments/:appointmentId`, manage, async (request) => {
    const { appointmentId } = appointmentParams.parse(request.params);
    const { companyId, membershipId } = membershipAuth(request);
    const body = patchAppointmentSchema.parse(request.body);
    const updated = await schedule.updateAppointment(companyId, membershipId, appointmentId, body);
    return toAppointmentResponse(await schedule.view(companyId, updated));
  });

  app.post(`${base}/blocks`, manage, async (request, reply) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = createBlocksSchema.parse(request.body);
    const created = await schedule.createBlocks(companyId, membershipId, body);
    const views = await schedule.viewMany(companyId, created);
    return reply.status(201).send({ items: views.map(toAppointmentResponse) });
  });

  app.delete(`${base}/blocks/:blockId`, manage, async (request, reply) => {
    const { blockId } = blockParams.parse(request.params);
    const { companyId, membershipId } = membershipAuth(request);
    await schedule.cancelBlock(companyId, membershipId, blockId);
    return reply.status(204).send();
  });

  done();
};
