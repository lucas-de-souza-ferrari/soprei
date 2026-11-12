import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  channelSetupSchema,
  channelStateSchema,
  conversationSchema,
  failureOf,
  messageSchema,
} from './company-api';
import {
  authorLabel,
  isAiPaused,
  isCompanySide,
  pauseBannerText,
  sendIndicator,
} from './conversation-format';
import { ApiError } from '../api';

// Spec 039 (E1 e E4): regras puras da coexistência no site.
const ID = '018f3c1e-5b7a-7c3e-9f10-2a4b6c8d0e1f';
const NOW = new Date('2026-11-12T15:00:00.000Z');

test('a mensagem HUMAN é da equipe: lado da empresa e rótulo em texto', () => {
  assert.equal(authorLabel('HUMAN'), 'Equipe (pelo celular)');
  assert.equal(authorLabel('ASSISTANT'), 'Assistente');
  assert.equal(authorLabel('USER'), 'Contato');
  assert.equal(isCompanySide('HUMAN'), true);
  assert.equal(isCompanySide('ASSISTANT'), true);
  assert.equal(isCompanySide('USER'), false);
  // A mensagem da equipe nunca mostra "Enviando…" nem "Não enviada".
  assert.equal(
    sendIndicator(
      { role: 'HUMAN', sentAt: null, createdAt: '2026-11-12T10:00:00.000Z' },
      'whatsapp',
      NOW,
    ),
    'none',
  );
});

test('pausa: só vale no futuro; o texto da faixa traz hora e dia no fuso pedido', () => {
  assert.equal(isAiPaused(null, NOW), false);
  assert.equal(isAiPaused(undefined, NOW), false);
  assert.equal(isAiPaused('2026-11-12T14:59:59.000Z', NOW), false);
  assert.equal(isAiPaused('2026-11-13T03:00:00.000Z', NOW), true);
  assert.equal(pauseBannerText('2026-11-12T14:00:00.000Z', NOW, 'America/Sao_Paulo'), null);
  assert.equal(
    pauseBannerText('2026-11-13T03:00:00.000Z', NOW, 'America/Sao_Paulo'),
    'A IA está pausada neste contato até 00:00 de 13/11 porque a equipe respondeu pelo celular.',
  );
});

test('contratos: role HUMAN e aiPausedUntil aceitos; telefone segue recusado', () => {
  assert.equal(
    messageSchema.safeParse({
      id: ID,
      role: 'HUMAN',
      content: 'oi',
      isFallback: false,
      replyToId: null,
      createdAt: '2026-11-12T10:00:00.000Z',
      sentAt: null,
    }).success,
    true,
  );
  const conversation = {
    id: ID,
    contactLabel: 'Contato final 1234',
    channel: 'whatsapp',
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    aiPausedUntil: '2026-11-12T22:00:00.000Z',
  };
  assert.equal(conversationSchema.safeParse(conversation).success, true);
  assert.equal(
    conversationSchema.safeParse({ ...conversation, aiPausedUntil: null }).success,
    true,
  );
  assert.equal(
    conversationSchema.safeParse({ ...conversation, contactRef: '5511999990000' }).success,
    false,
  );
});

test('canal: mode e coexistence do setup; setup antigo (sem coexistence) vale indisponível', () => {
  const state = channelStateSchema.parse({
    state: 'CONNECTED',
    phoneNumberId: '1',
    wabaId: '2',
    tokenExpiresAt: null,
    connectedAt: null,
    tokenInvalidAt: null,
    mode: 'COEXISTENCE',
  });
  assert.equal(state.mode, 'COEXISTENCE');
  const old = channelSetupSchema.parse({ embeddedSignup: null, manualConnect: false });
  assert.deepEqual(old.coexistence, { available: false, configId: null });
  const on = channelSetupSchema.parse({
    embeddedSignup: { appId: '1', configId: '2', graphApiVersion: 'v26.0' },
    manualConnect: false,
    coexistence: { available: true, configId: '2' },
  });
  assert.equal(on.coexistence.available, true);
});

test('mensagens de erro da coexistência escolhidas pelo código, nunca pelo texto do servidor', () => {
  const ambiguous = failureOf(
    new ApiError(400, 'texto do servidor com 5511999990000', 'CHANNEL_NUMBER_AMBIGUOUS'),
  );
  assert.deepEqual(ambiguous, {
    kind: 'message',
    text: 'Não foi possível identificar o número. Escolha o número no aplicativo e tente de novo.',
  });
  const disabled = failureOf(new ApiError(400, 'qualquer', 'CHANNEL_COEXISTENCE_DISABLED'));
  assert.equal(disabled.kind === 'message' && disabled.text.includes('qualquer'), false);
});
