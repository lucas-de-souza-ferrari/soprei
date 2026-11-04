import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiError } from '../api';
import { pageForPath, pathForPage } from '../account-flow';
import { allowedPages, areaPath, canOpen } from './company-nav';
import {
  channelSetupSchema,
  channelStateSchema,
  failureOf,
  FORBIDDEN_MESSAGE,
  GENERIC_MESSAGE,
  RATE_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from './company-api';

const SENTINEL = 'TEXTO-DO-SERVIDOR-QUE-NAO-PODE-APARECER';

test('mensagens de erro do canal: escolhidas pelo código e nunca pelo texto do servidor', () => {
  const cases: [number, string | undefined, string][] = [
    [400, 'CHANNEL_TOKEN_REJECTED', 'A Meta recusou a autorização. Tente conectar de novo.'],
    [
      400,
      'CHANNEL_WRONG_APP',
      'A autorização não veio do aplicativo do Soprei. Tente conectar de novo pela janela do site.',
    ],
    [
      400,
      'CHANNEL_MISSING_SCOPE',
      'Faltou conceder todas as permissões do WhatsApp. Conecte de novo e aceite todas.',
    ],
    [
      400,
      'CHANNEL_NUMBER_NOT_IN_WABA',
      'Esse número não pertence à conta escolhida. Selecione o número na janela da Meta.',
    ],
    [409, 'CHANNEL_NUMBER_IN_USE', 'Esse número já está conectado a outra empresa.'],
    [400, 'CHANNEL_CODE_INVALID', 'A autorização expirou ou já foi usada. Tente de novo.'],
    [
      400,
      'CHANNEL_REGISTRATION_FAILED',
      'Não foi possível registrar o número na Meta. Tente de novo; se persistir, fale com o suporte.',
    ],
    [502, undefined, UNAVAILABLE_MESSAGE],
    [503, 'SERVICE_UNAVAILABLE', UNAVAILABLE_MESSAGE],
    [429, 'RATE_LIMITED', RATE_MESSAGE],
    [403, 'FORBIDDEN', FORBIDDEN_MESSAGE],
    [400, undefined, GENERIC_MESSAGE],
    [400, 'VALIDATION_ERROR', GENERIC_MESSAGE],
    [500, undefined, GENERIC_MESSAGE],
  ];
  for (const [status, code, text] of cases) {
    const failure = failureOf(new ApiError(status, SENTINEL, code));
    assert.deepEqual(failure, { kind: 'message', text }, `${String(status)} ${String(code)}`);
  }
  assert.deepEqual(failureOf(new ApiError(401, SENTINEL)), { kind: 'session' });
  assert.deepEqual(failureOf(new ApiError(404, SENTINEL, 'NOT_FOUND')), { kind: 'changed' });
  // Rede, resposta fora do schema e qualquer outra coisa viram a mensagem genérica.
  assert.deepEqual(failureOf(new TypeError(SENTINEL)), { kind: 'message', text: GENERIC_MESSAGE });
  assert.deepEqual(failureOf(channelStateSchema.safeParse({}).error), {
    kind: 'message',
    text: GENERIC_MESSAGE,
  });
});

test('menu da empresa: abas por permissão do servidor, por papel', () => {
  const owner = [
    'conversation:read',
    'conversation:simulate',
    'channel:read',
    'channel:manage',
    'persona:manage',
  ];
  const agent = ['conversation:read', 'conversation:simulate'];
  const viewer = ['conversation:read'];
  assert.deepEqual(allowedPages(owner), ['conversas', 'canal', 'persona', 'testar']);
  assert.deepEqual(allowedPages(agent), ['conversas', 'testar']);
  assert.deepEqual(allowedPages(viewer), ['conversas']);
  assert.equal(canOpen('canal', agent), false);
  assert.equal(canOpen('persona', agent), false);
  assert.equal(canOpen('testar', viewer), false);
  assert.equal(canOpen('conversas', viewer), true);
  assert.deepEqual(allowedPages([]), []);
});

test('rotas da área da empresa: sem ids na URL', () => {
  for (const page of ['conversas', 'canal', 'persona', 'testar'] as const) {
    assert.match(areaPath(page), /^\/painel\/[a-z]+$/);
    assert.equal(pageForPath(areaPath(page)), page);
    assert.equal(pathForPage(page), areaPath(page));
  }
  assert.equal(pageForPath('/painel/canal/abc'), 'login');
});

test('contratos: o estado do canal e o setup só aceitam o formato do servidor', () => {
  const ok = {
    state: 'CONNECTED',
    phoneNumberId: '1',
    wabaId: '2',
    tokenExpiresAt: null,
    connectedAt: '2026-11-04T10:00:00.000Z',
    tokenInvalidAt: null,
  };
  assert.ok(channelStateSchema.safeParse(ok).success);
  assert.equal(channelStateSchema.safeParse({ ...ok, state: 'OUTRO' }).success, false);
  assert.ok(
    channelSetupSchema.safeParse({
      embeddedSignup: { appId: '123', configId: '456', graphApiVersion: 'v26.0' },
      manualConnect: false,
    }).success,
  );
  assert.ok(channelSetupSchema.safeParse({ embeddedSignup: null, manualConnect: true }).success);
  assert.equal(
    channelSetupSchema.safeParse({
      embeddedSignup: { appId: 'abc', configId: '456', graphApiVersion: 'v26.0' },
      manualConnect: false,
    }).success,
    false,
  );
});
