import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Appointment,
  type AppointmentRepository,
  type AppointmentStatus,
  CompanyId,
} from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { ScheduleService } from './schedule.service.js';

const COMPANY = CompanyId.parse('0195f3a0-aaaa-7bbb-8ccc-1234567890ab');
const base = (status: AppointmentStatus): Appointment => ({
  id: 'a1',
  companyId: COMPANY,
  resourceId: 'r1',
  serviceId: 's1',
  kind: 'BOOKING',
  status,
  startsAt: new Date('2026-12-01T13:00:00Z'),
  endsAt: new Date('2026-12-01T13:30:00Z'),
  blockedUntil: new Date('2026-12-01T13:30:00Z'),
  customerLabel: null,
  contactRef: null,
  source: 'PANEL',
  createdByMembershipId: null,
  cancelledAt: null,
  cancelledBy: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
});

/** Repositório falso: a primeira `transition` perde a corrida (PENDING virou o estado `racedTo`). */
function service(racedTo: AppointmentStatus) {
  let stored = base('PENDING');
  let calls = 0;
  const appointments = {
    findById: () => Promise.resolve(stored),
    transition: (
      _c: CompanyId,
      _id: string,
      change: { from: AppointmentStatus; to: AppointmentStatus },
    ) => {
      calls += 1;
      if (calls === 1) {
        stored = base(racedTo);
        return Promise.resolve(null);
      }
      if (stored.status !== change.from) return Promise.resolve(null);
      stored = base(change.to);
      return Promise.resolve(stored);
    },
  } as unknown as AppointmentRepository;
  const svc = new ScheduleService({
    settings: {} as never,
    resources: {} as never,
    services: {} as never,
    rules: {} as never,
    appointments,
    logger: { info: () => undefined },
    now: () => new Date('2026-12-02T00:00:00Z'),
  });
  return { svc, calls: () => calls };
}

describe('corrida em changeStatus (spec 027, sugestão da revisão)', () => {
  it('PENDING virou CONFIRMED no meio de um cancelamento: reavalia e cancela, sem 409', async () => {
    const { svc, calls } = service('CONFIRMED');
    const result = await svc.updateAppointment(COMPANY, 'm1', 'a1', { status: 'CANCELLED' });
    assert.equal(result.status, 'CANCELLED');
    assert.equal(calls(), 2);
  });

  it('se o novo estado já não permite a transição, continua 409 INVALID_TRANSITION', async () => {
    const { svc } = service('COMPLETED');
    await assert.rejects(
      svc.updateAppointment(COMPANY, 'm1', 'a1', { status: 'CANCELLED' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'INVALID_TRANSITION',
    );
  });

  it('se outra mudança já deixou no estado pedido, devolve o mesmo resultado', async () => {
    const { svc } = service('CANCELLED');
    const result = await svc.updateAppointment(COMPANY, 'm1', 'a1', { status: 'CANCELLED' });
    assert.equal(result.status, 'CANCELLED');
  });
});
