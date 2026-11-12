import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pageForPath, pathForPage } from '../account-flow';
import { allowedPages, areaPageForPath, canOpen } from './company-nav';
import { conversationSchema, messagesPageSchema } from './company-api';
import {
  notificationSchema,
  notificationsPageSchema,
  reasonLabel,
  REASON_LABELS,
  summarySchema,
} from './notifications-api';
import {
  badgeText,
  bellLabel,
  NOTIFICATION_POLL_MS,
  shouldAnnounce,
  SummaryPoller,
} from './notification-rules';

// Spec 038: sino, tela de notificações e campos novos das conversas.

const ID = '0195f5a4-6f1a-7c3e-9b2d-1a2b3c4d5e6f';
const OTHER = '0195f5a4-6f1a-7c3e-9b2d-1a2b3c4d5e70';
const NOW = '2026-11-11T12:00:00.000Z';

const notification = {
  id: ID,
  kind: 'HUMAN_HANDOFF',
  reason: 'CONTACT_REQUESTED',
  status: 'OPEN',
  conversation: { id: OTHER, contactLabel: 'Contato final 4321', channel: 'whatsapp' },
  createdAt: NOW,
  resolvedAt: null,
  resolvedByMe: false,
};

test('selo: vazio com zero, número até 99 e "99+" acima; nome acessível do sino', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(bellLabel(0), 'Notificações');
  assert.equal(bellLabel(1), 'Notificações, 1 aberta');
  assert.equal(bellLabel(3), 'Notificações, 3 abertas');
  assert.equal(bellLabel(250), 'Notificações, 99+ abertas');
});

test('aviso de chegada só quando a contagem sobe (a primeira leitura não avisa)', () => {
  assert.equal(shouldAnnounce(null, 5), false);
  assert.equal(shouldAnnounce(2, 3), true);
  assert.equal(shouldAnnounce(3, 3), false);
  assert.equal(shouldAnnounce(3, 1), false);
});

/** Relógio falso: guarda os temporizadores e os dispara sob comando. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fireAll: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.fn();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('poller: lê ao começar, agenda a cada 30 s com a aba visível e para com ela oculta', async () => {
  const timers = fakeTimers();
  let visible = true;
  let reads = 0;
  const counts: number[] = [];
  const poller = new SummaryPoller({
    read: () => Promise.resolve(++reads),
    onCount: (count) => counts.push(count),
    isVisible: () => visible,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  poller.start();
  await flush();
  assert.deepEqual(counts, [1]);
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0]?.ms, NOTIFICATION_POLL_MS);

  timers.fireAll();
  await flush();
  assert.deepEqual(counts, [1, 2]);

  // Aba oculta: o temporizador some e nada é lido.
  visible = false;
  poller.visibilityChanged();
  assert.equal(timers.pending.size, 0);
  await flush();
  assert.equal(reads, 2);

  // Voltou a ficar visível: lê na hora e reagenda.
  visible = true;
  poller.visibilityChanged();
  await flush();
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(timers.pending.size, 1);
  poller.stop();
  assert.equal(timers.pending.size, 0);
});

test('poller: falha de leitura mantém o último valor e não acelera; stop descarta resposta tardia', async () => {
  const timers = fakeTimers();
  const counts: number[] = [];
  let fail = false;
  let release: ((value: number) => void) | undefined;
  const poller = new SummaryPoller({
    read: () => {
      if (fail) return Promise.reject(new Error('fora'));
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    },
    onCount: (count) => counts.push(count),
    isVisible: () => true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  poller.start();
  release?.(4);
  await flush();
  assert.deepEqual(counts, [4]);

  fail = true;
  timers.fireAll();
  await flush();
  assert.deepEqual(counts, [4], 'a falha não muda o sino');
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0]?.ms, NOTIFICATION_POLL_MS, 'mesmo intervalo');

  // Resposta que chega depois de trocar de empresa (stop) é descartada.
  fail = false;
  poller.refresh();
  poller.stop();
  release?.(9);
  await flush();
  assert.deepEqual(counts, [4]);
  assert.equal(timers.pending.size, 0);
});

test('contratos: notificação estrita (sem contactRef, externalId nem id de quem resolveu)', () => {
  assert.ok(notificationSchema.safeParse(notification).success);
  for (const extra of [
    { contactRef: '5511987654321' },
    { externalId: 'wamid.x' },
    { resolvedByMembershipId: OTHER },
    { messageId: OTHER },
  ]) {
    assert.equal(notificationSchema.safeParse({ ...notification, ...extra }).success, false);
  }
  assert.equal(
    notificationSchema.safeParse({
      ...notification,
      conversation: { ...notification.conversation, contactRef: '55119' },
    }).success,
    false,
  );
  assert.ok(notificationsPageSchema.safeParse({ items: [notification], nextCursor: null }).success);
  assert.ok(summarySchema.safeParse({ open: 3 }).success);
  assert.equal(summarySchema.safeParse({ open: -1 }).success, false);
});

test('motivos: texto fixo do site para cada código; nulo vira "Outro motivo"', () => {
  assert.equal(reasonLabel('CONTACT_REQUESTED'), REASON_LABELS.CONTACT_REQUESTED);
  assert.equal(reasonLabel(null), REASON_LABELS.OTHER);
  assert.equal(new Set(Object.values(REASON_LABELS)).size, 5);
});

test('conversas: openHandoff aceito na lista (booleano) e no histórico (objeto ou nulo)', () => {
  const conversation = {
    id: OTHER,
    contactLabel: 'Contato final 4321',
    channel: 'whatsapp',
    createdAt: NOW,
    updatedAt: NOW,
  };
  assert.ok(conversationSchema.safeParse(conversation).success, 'sem o campo (servidor antigo)');
  assert.ok(conversationSchema.safeParse({ ...conversation, openHandoff: true }).success);
  const page = (openHandoff: unknown) => ({
    conversation: { ...conversation, openHandoff },
    items: [],
    nextCursor: null,
  });
  assert.ok(messagesPageSchema.safeParse(page(null)).success);
  assert.ok(
    messagesPageSchema.safeParse(page({ notificationId: ID, reason: 'COMPLAINT', createdAt: NOW }))
      .success,
  );
  assert.equal(
    messagesPageSchema.safeParse(
      page({ notificationId: ID, reason: 'COMPLAINT', createdAt: NOW, contactRef: 'x' }),
    ).success,
    false,
  );
});

test('rota: /painel/notificacoes é tela escondida do menu, com notification:read', () => {
  assert.equal(areaPageForPath('/painel/notificacoes'), 'notificacoes');
  assert.equal(pathForPage('notificacoes'), '/painel/notificacoes');
  assert.equal(pageForPath('/painel/notificacoes'), 'notificacoes');
  assert.equal(canOpen('notificacoes', ['notification:read']), true);
  assert.equal(canOpen('notificacoes', ['conversation:read']), false);
  assert.equal(
    allowedPages(['notification:read', 'conversation:read']).includes('notificacoes'),
    false,
  );
});
