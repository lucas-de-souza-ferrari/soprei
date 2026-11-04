import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InvitationExpiryRepository } from '../../domain/index.js';
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from '../auth/unverified-account-purger.js';
import {
  InvitationExpiryPurger,
  type InvitationExpiryRunSummary,
} from './invitation-expiry-purger.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function fakeRepository(batches: (number | Error)[]) {
  const calls: { cutoff: Date; batchSize: number }[] = [];
  const repository: InvitationExpiryRepository = {
    expirePending: (cutoff, batchSize) => {
      calls.push({ cutoff, batchSize });
      const next = batches.shift() ?? 0;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { repository, calls };
}

test('o corte é 7 dias antes de agora (a data de vencimento) e o lote é de 100', async () => {
  const { repository, calls } = fakeRepository([3]);
  const summaries: InvitationExpiryRunSummary[] = [];
  const purger = new InvitationExpiryPurger({
    repository,
    now: () => NOW,
    onRun: (summary) => summaries.push(summary),
  });
  const summary = await purger.runOnce();
  assert.deepEqual(summary, { result: 'ok', expired: 3, batches: 1 });
  assert.deepEqual(summaries, [summary]);
  assert.equal(calls[0]?.batchSize, PURGE_BATCH_SIZE);
  assert.equal(calls[0].cutoff.getTime(), NOW.getTime() - 7 * DAY);
});

test('repete lotes cheios até o teto por execução e para no primeiro lote incompleto', async () => {
  const full = fakeRepository(Array.from({ length: 30 }, () => PURGE_BATCH_SIZE));
  const capped = await new InvitationExpiryPurger({
    repository: full.repository,
    now: () => NOW,
  }).runOnce();
  assert.equal(capped.batches, PURGE_MAX_BATCHES);
  assert.equal(capped.expired, PURGE_MAX_BATCHES * PURGE_BATCH_SIZE);

  const partial = fakeRepository([PURGE_BATCH_SIZE, 40, 99]);
  const summary = await new InvitationExpiryPurger({
    repository: partial.repository,
    now: () => NOW,
  }).runOnce();
  assert.deepEqual(summary, { result: 'ok', expired: PURGE_BATCH_SIZE + 40, batches: 2 });
});

test('erro do repositório vira resultado error (nunca rejeita) e falha do observador não derruba', async () => {
  const failing = fakeRepository([new Error('banco fora')]);
  const summary = await new InvitationExpiryPurger({
    repository: failing.repository,
    now: () => NOW,
    onRun: () => {
      throw new Error('observador');
    },
  }).runOnce();
  assert.deepEqual(summary, { result: 'error', expired: 0, batches: 0 });
});
