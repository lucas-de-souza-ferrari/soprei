import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  type CompanyId,
  type CompanyInvitationRepository,
  type NewCompanyInvitation,
} from '../domain/index.js';
import { ConflictError, NotFoundError } from '../shared/errors/index.js';

/** O que o contrato precisa de cada implementação: o repositório e duas empresas com vínculos reais. */
export interface InvitationContractWorld {
  readonly repository: CompanyInvitationRepository;
  readonly companyA: CompanyId;
  readonly companyB: CompanyId;
  /** Um vínculo existente em cada empresa (convidador e vínculo que aceita). */
  readonly inviterA: string;
  readonly acceptedA: string;
  readonly inviterB: string;
}

const T0 = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function email(label: string): string {
  return `${label}-${randomUUID()}@contrato.test`;
}

/**
 * Contrato de `CompanyInvitationRepository` (spec 025): o mesmo roteiro roda no em memória e no
 * Postgres. `world` é chamado uma vez por teste (cada teste usa e-mails únicos).
 */
export function describeInvitationRepositoryContract(
  name: string,
  world: () => Promise<InvitationContractWorld>,
): void {
  void describe(`contrato do repositório de convites: ${name}`, () => {
    function input(
      w: InvitationContractWorld,
      address: string,
      inviter: string = w.inviterA,
    ): NewCompanyInvitation {
      return {
        email: address,
        role: 'AGENT',
        tokenHash: `hash-${randomUUID()}`,
        invitedByMembershipId: inviter,
        expiresAt: new Date(T0.getTime() + 7 * DAY),
        now: T0,
      };
    }

    void it('cria como PENDING com um envio e acha pelo id só na própria empresa', async () => {
      const w = await world();
      const address = email('a');
      const created = await w.repository.create(w.companyA, input(w, address));
      assert.equal(created.status, 'PENDING');
      assert.equal(created.email, address);
      assert.equal(created.role, 'AGENT');
      assert.equal(created.sendCount, 1);
      assert.equal(created.closedAt, null);
      assert.equal(created.acceptedMembershipId, null);
      assert.equal(created.lastSentAt.getTime(), T0.getTime());
      const found = await w.repository.findById(w.companyA, created.id);
      assert.equal(found.id, created.id);
      assert.equal(found.tokenHash, created.tokenHash);
      // Outra empresa e id malformado: o mesmo NotFoundError de inexistente.
      await assert.rejects(w.repository.findById(w.companyB, created.id), NotFoundError);
      await assert.rejects(w.repository.findById(w.companyA, randomUUID()), NotFoundError);
      await assert.rejects(w.repository.findById(w.companyA, 'nao-e-uuid'), NotFoundError);
    });

    void it('um PENDING por e-mail e empresa: repetido é ConflictError; outra empresa e depois de fechado, não', async () => {
      const w = await world();
      const address = email('dup');
      const first = await w.repository.create(w.companyA, input(w, address));
      await assert.rejects(w.repository.create(w.companyA, input(w, address)), ConflictError);
      // Mesmo e-mail em outra empresa é permitido.
      await w.repository.create(w.companyB, input(w, address, w.inviterB));
      // Depois de fechado, o e-mail volta a ser convidável.
      assert.equal(
        await w.repository.close(w.companyA, first.id, { status: 'REVOKED', closedAt: T0 }),
        true,
      );
      const again = await w.repository.create(w.companyA, input(w, address));
      assert.notEqual(again.id, first.id);
    });

    void it('findPendingByEmail só vê o PENDING da própria empresa', async () => {
      const w = await world();
      const address = email('find');
      const created = await w.repository.create(w.companyA, input(w, address));
      assert.equal((await w.repository.findPendingByEmail(w.companyA, address))?.id, created.id);
      assert.equal(await w.repository.findPendingByEmail(w.companyB, address), null);
      await w.repository.close(w.companyA, created.id, { status: 'EXPIRED', closedAt: T0 });
      assert.equal(await w.repository.findPendingByEmail(w.companyA, address), null);
    });

    void it('fechar anula e-mail e hash (ACCEPTED guarda o vínculo) e só fecha PENDING da própria empresa', async () => {
      const w = await world();
      const accepted = await w.repository.create(w.companyA, input(w, email('acc')));
      // Empresa errada: nada muda.
      assert.equal(
        await w.repository.close(w.companyB, accepted.id, { status: 'REVOKED', closedAt: T0 }),
        false,
      );
      assert.equal((await w.repository.findById(w.companyA, accepted.id)).status, 'PENDING');
      assert.equal(
        await w.repository.close(w.companyA, accepted.id, {
          status: 'ACCEPTED',
          closedAt: T0,
          acceptedMembershipId: w.acceptedA,
        }),
        true,
      );
      const closed = await w.repository.findById(w.companyA, accepted.id);
      assert.equal(closed.status, 'ACCEPTED');
      assert.equal(closed.email, null);
      assert.equal(closed.tokenHash, null);
      assert.equal(closed.acceptedMembershipId, w.acceptedA);
      assert.equal(closed.closedAt?.getTime(), T0.getTime());
      // Já fechado: não fecha de novo nem reverte.
      assert.equal(
        await w.repository.close(w.companyA, accepted.id, { status: 'REVOKED', closedAt: T0 }),
        false,
      );
      assert.equal((await w.repository.findById(w.companyA, accepted.id)).status, 'ACCEPTED');

      const revoked = await w.repository.create(w.companyA, input(w, email('rev')));
      await w.repository.close(w.companyA, revoked.id, { status: 'REVOKED', closedAt: T0 });
      const row = await w.repository.findById(w.companyA, revoked.id);
      assert.equal(row.email, null);
      assert.equal(row.tokenHash, null);
      assert.equal(row.acceptedMembershipId, null);
    });

    void it('lista só os PENDING da empresa, por cursor, sem repetir nem pular', async () => {
      const w = await world();
      const marker = randomUUID();
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const created = await w.repository.create(w.companyA, {
          ...input(w, `${marker}-${String(index)}@contrato.test`),
          now: new Date(T0.getTime() + index * 1000),
        });
        ids.push(created.id);
      }
      await w.repository.close(w.companyA, ids[1] ?? '', { status: 'REVOKED', closedAt: T0 });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await w.repository.listPending(w.companyA, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items) {
          assert.equal(item.status, 'PENDING');
          if (item.email?.startsWith(marker) === true) seen.push(item.id);
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      assert.deepEqual(seen.sort(), ids.filter((id) => id !== ids[1]).sort());
      const other = await w.repository.listPending(w.companyB, { limit: 200 });
      assert.ok(other.items.every((item) => !item.email?.startsWith(marker)));
    });

    void it('conta PENDING não vencidos por empresa', async () => {
      const w = await world();
      const before = await w.repository.countPending(w.companyA, T0);
      const live = await w.repository.create(w.companyA, input(w, email('live')));
      await w.repository.create(w.companyA, {
        ...input(w, email('old')),
        expiresAt: new Date(T0.getTime() - 1),
      });
      assert.equal(await w.repository.countPending(w.companyA, T0), before + 1);
      assert.equal(
        await w.repository.countPending(w.companyA, new Date(live.expiresAt.getTime() + 1)),
        0,
      );
      assert.ok((await w.repository.countPending(w.companyB, T0)) >= 0);
    });

    void it('renew troca o hash e a validade, soma um envio e só vale em PENDING da própria empresa', async () => {
      const w = await world();
      const created = await w.repository.create(w.companyA, input(w, email('ren')));
      const later = new Date(T0.getTime() + 5 * 60_000);
      const renewal = {
        tokenHash: `novo-${randomUUID()}`,
        expiresAt: new Date(later.getTime() + 7 * DAY),
        lastSentAt: later,
      };
      assert.equal(await w.repository.renew(w.companyB, created.id, renewal), null);
      const renewed = await w.repository.renew(w.companyA, created.id, renewal);
      assert.equal(renewed?.sendCount, 2);
      assert.equal(renewed.tokenHash, renewal.tokenHash);
      assert.equal(renewed.lastSentAt.getTime(), later.getTime());
      assert.equal(renewed.expiresAt.getTime(), renewal.expiresAt.getTime());
      await w.repository.close(w.companyA, created.id, { status: 'REVOKED', closedAt: later });
      assert.equal(await w.repository.renew(w.companyA, created.id, renewal), null);
      assert.equal(await w.repository.renew(w.companyA, 'nao-e-uuid', renewal), null);
    });
  });
}
