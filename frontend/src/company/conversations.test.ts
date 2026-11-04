import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pageForPath, pathForPage } from '../account-flow';
import {
  allowedPages,
  areaPageForPath,
  areaPath,
  canOpen,
  conversasPath,
  conversasRouteForPath,
} from './company-nav';
import {
  conversationSchema,
  conversationsPageSchema,
  messageSchema,
  messagesPageSchema,
} from './company-api';
import {
  chronological,
  dayKey,
  dayLabel,
  formatActivity,
  formatTime,
  SEND_GRACE_MS,
  sendIndicator,
  withDaySeparators,
} from './conversation-format';

const ID = '018f3c1e-5b7a-7c3e-9f10-2a4b6c8d0e1f';
const OTHER_ID = '018f3c1e-5b7a-7c3e-9f10-2a4b6c8d0e20';
const BRT = 'America/Sao_Paulo';

test('rotas da aba Conversas: lista, conversa por UUID e id que não é UUID', () => {
  assert.deepEqual(conversasRouteForPath('/painel/conversas'), { kind: 'list' });
  assert.deepEqual(conversasRouteForPath(`/painel/conversas/${ID}`), { kind: 'detail', id: ID });
  assert.deepEqual(conversasRouteForPath(`/painel/conversas/${ID.toUpperCase()}`), {
    kind: 'detail',
    id: ID,
  });
  for (const bad of [
    '/painel/conversas/abc',
    '/painel/conversas/',
    `/painel/conversas/${ID}/extra`,
    '/painel/conversas/%2e%2e',
    `/painel/conversas/${ID}x`,
  ]) {
    assert.deepEqual(conversasRouteForPath(bad), { kind: 'invalid' }, bad);
  }
  assert.equal(conversasRouteForPath('/painel/canal'), null);
  assert.equal(conversasRouteForPath('/painel/conversas-outra'), null);
  assert.equal(conversasPath({ kind: 'list' }), '/painel/conversas');
  assert.equal(conversasPath({ kind: 'detail', id: ID }), `/painel/conversas/${ID}`);
});

test('a aba Conversas é a primeira e vale para quem tem conversation:read', () => {
  assert.equal(areaPath('conversas'), '/painel/conversas');
  assert.equal(areaPageForPath('/painel/conversas'), 'conversas');
  assert.equal(areaPageForPath(`/painel/conversas/${ID}`), 'conversas');
  // Um id inválido ainda é da área (a tela diz "não encontrada" sem chamar a API).
  assert.equal(areaPageForPath('/painel/conversas/abc'), 'conversas');
  assert.equal(pageForPath(`/painel/conversas/${ID}`), 'conversas');
  assert.equal(pathForPage('conversas'), '/painel/conversas');
  assert.equal(canOpen('conversas', ['conversation:read']), true);
  assert.equal(canOpen('conversas', ['conversation:simulate']), false);
  assert.equal(canOpen('conversas', []), false);
  assert.deepEqual(allowedPages(['conversation:read']), ['conversas']);
  assert.equal(
    allowedPages([
      'conversation:read',
      'channel:read',
      'persona:manage',
      'conversation:simulate',
    ])[0],
    'conversas',
  );
});

test('contrato do cliente: recusa contactRef, externalId, campo desconhecido e papel desconhecido', () => {
  const conversation = {
    id: ID,
    contactLabel: 'Contato final 1234',
    channel: 'whatsapp',
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-04T11:00:00.000Z',
  };
  assert.ok(conversationSchema.safeParse(conversation).success);
  assert.equal(
    conversationSchema.safeParse({ ...conversation, contactRef: '5511999991234' }).success,
    false,
  );
  assert.equal(conversationSchema.safeParse({ ...conversation, channel: 'sms' }).success, false);
  assert.equal(conversationSchema.safeParse({ ...conversation, extra: 1 }).success, false);
  assert.equal(
    conversationSchema.safeParse({ ...conversation, updatedAt: 'ontem' }).success,
    false,
  );
  assert.ok(conversationsPageSchema.safeParse({ items: [conversation], nextCursor: null }).success);

  const message = {
    id: OTHER_ID,
    role: 'USER',
    content: 'olá',
    isFallback: false,
    replyToId: null,
    createdAt: '2026-11-04T10:00:00.000Z',
    sentAt: null,
  };
  assert.ok(messageSchema.safeParse(message).success);
  assert.ok(
    messageSchema.safeParse({ ...message, role: 'ASSISTANT', sentAt: '2026-11-04T10:00:01.000Z' })
      .success,
  );
  assert.equal(messageSchema.safeParse({ ...message, externalId: 'wamid.X' }).success, false);
  assert.equal(messageSchema.safeParse({ ...message, role: 'SYSTEM' }).success, false);
  assert.equal(messageSchema.safeParse({ ...message, role: 'user' }).success, false);
  assert.ok(
    messagesPageSchema.safeParse({ conversation, items: [message], nextCursor: 'abc' }).success,
  );
  // A página sem a conversa (contrato antigo) também é recusada.
  assert.equal(messagesPageSchema.safeParse({ items: [message], nextCursor: null }).success, false);
});

test('data e hora: hoje, ontem, outro dia e a virada de dia no fuso do navegador', () => {
  // 04/11/2026 15:30 em São Paulo (UTC-3) = 18:30 UTC.
  const now = new Date('2026-11-04T18:30:00.000Z');
  assert.equal(formatActivity('2026-11-04T12:05:00.000Z', now, BRT), 'Hoje, 09:05');
  assert.equal(formatActivity('2026-11-03T20:00:00.000Z', now, BRT), 'Ontem, 17:00');
  assert.equal(formatActivity('2026-10-30T20:00:00.000Z', now, BRT), '30/10/2026, 17:00');
  assert.equal(dayLabel('2026-11-04T12:05:00.000Z', now, BRT), 'Hoje');
  assert.equal(dayLabel('2026-11-03T12:05:00.000Z', now, BRT), 'Ontem');
  assert.equal(dayLabel('2026-10-30T12:05:00.000Z', now, BRT), '30/10/2026');
  assert.equal(formatTime('2026-11-04T12:05:00.000Z', BRT), '09:05');
  // 02:30 UTC de 05/11 ainda é 23:30 de 04/11 em São Paulo; em UTC já é outro dia.
  const lateNight = '2026-11-05T02:30:00.000Z';
  assert.equal(dayKey(lateNight, BRT), '2026-11-04');
  assert.equal(dayKey(lateNight, 'UTC'), '2026-11-05');
  assert.equal(dayLabel(lateNight, now, BRT), 'Hoje');
  assert.equal(dayLabel(lateNight, now, 'UTC'), '05/11/2026');
  // Virada de mês e de ano contam como "ontem".
  assert.equal(
    dayLabel('2026-12-31T15:00:00.000Z', new Date('2027-01-01T15:00:00.000Z'), BRT),
    'Ontem',
  );
});

test('separador de dia aparece só quando o dia civil muda', () => {
  const now = new Date('2026-11-04T18:30:00.000Z');
  const at = (createdAt: string, id: string) => ({
    id,
    role: 'USER' as const,
    content: 'x',
    isFallback: false,
    replyToId: null,
    createdAt,
    sentAt: null,
  });
  const entries = withDaySeparators(
    [
      at('2026-11-03T13:00:00.000Z', '1'),
      at('2026-11-03T14:00:00.000Z', '2'),
      at('2026-11-04T12:00:00.000Z', '3'),
    ],
    now,
    BRT,
  );
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === 'day' ? `dia:${entry.label}` : `msg:${entry.message.id}`,
    ),
    ['dia:Ontem', 'msg:1', 'msg:2', 'dia:Hoje', 'msg:3'],
  );
  assert.deepEqual(withDaySeparators([], now, BRT), []);
});

test('indicador de envio: só resposta do assistente em conversa do WhatsApp, com limite de 2 minutos', () => {
  const created = '2026-11-04T12:00:00.000Z';
  const base = new Date(created).getTime();
  const reply = { role: 'ASSISTANT' as const, createdAt: created, sentAt: null };
  const at = (ms: number) => new Date(base + ms);
  assert.equal(sendIndicator(reply, 'whatsapp', at(0)), 'sending');
  assert.equal(sendIndicator(reply, 'whatsapp', at(SEND_GRACE_MS - 1)), 'sending');
  assert.equal(sendIndicator(reply, 'whatsapp', at(SEND_GRACE_MS)), 'sending');
  assert.equal(sendIndicator(reply, 'whatsapp', at(SEND_GRACE_MS + 1)), 'not-sent');
  assert.equal(sendIndicator(reply, 'whatsapp', at(-5_000)), 'sending');
  assert.equal(SEND_GRACE_MS, 120_000);
  // Enviada: sem indicador, em qualquer idade.
  assert.equal(
    sendIndicator(
      { ...reply, sentAt: '2026-11-04T12:00:01.000Z' },
      'whatsapp',
      at(10 * SEND_GRACE_MS),
    ),
    'none',
  );
  // Simulador nunca vai ao canal: nunca há indicador.
  assert.equal(sendIndicator(reply, 'simulator', at(10 * SEND_GRACE_MS)), 'none');
  // Mensagem do contato não tem envio.
  assert.equal(
    sendIndicator({ ...reply, role: 'USER' }, 'whatsapp', at(10 * SEND_GRACE_MS)),
    'none',
  );
});

test('a página buscada com order=desc vira ordem cronológica sem alterar a original', () => {
  const descending = ['c', 'b', 'a'] as const;
  assert.deepEqual(chronological(descending), ['a', 'b', 'c']);
  assert.deepEqual(descending, ['c', 'b', 'a']);
  assert.deepEqual(chronological([]), []);
});
