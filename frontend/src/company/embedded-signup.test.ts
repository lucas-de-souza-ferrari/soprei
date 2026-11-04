import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSignupEvent, MAX_EVENT_TEXT_LENGTH } from './embedded-signup-event';
import {
  CODE_MAX_AGE_MS,
  INITIAL_SIGNUP_STATE,
  OTHER_HALF_TIMEOUT_MS,
  stepSignup,
  type SignupEffect,
  type SignupInput,
  type SignupState,
} from './embedded-signup-state';

const WWW = 'https://www.facebook.com';
const WEB = 'https://web.facebook.com';
const finish = (extra: Record<string, unknown> = {}) => ({
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH',
  data: {
    phone_number_id: '106540352242922',
    waba_id: '102290129340398',
    business_id: '1',
    ...extra,
  },
});

test('parser: FINISH bem formado das duas origens da Meta, como texto JSON ou objeto', () => {
  const expected = { kind: 'finish', phoneNumberId: '106540352242922', wabaId: '102290129340398' };
  for (const origin of [WWW, WEB]) {
    assert.deepEqual(parseSignupEvent(origin, JSON.stringify(finish())), expected);
    assert.deepEqual(parseSignupEvent(origin, finish()), expected);
  }
});

test('parser: ignora origem fora da lista estrita (nunca endsWith nem includes)', () => {
  const body = JSON.stringify(finish());
  for (const origin of [
    'https://evil.example',
    'http://www.facebook.com',
    'https://www.facebook.com.evil.example',
    'https://evilfacebook.com',
    'https://facebook.com',
    'https://www.facebook.com:8443',
    'null',
    '',
    'https://WWW.facebook.com',
  ]) {
    assert.equal(parseSignupEvent(origin, body), null, origin);
  }
});

test('parser: ignora tipo diferente, JSON inválido, texto grande, ids ruins e formato desconhecido', () => {
  assert.equal(parseSignupEvent(WWW, JSON.stringify({ ...finish(), type: 'OUTRO' })), null);
  assert.equal(parseSignupEvent(WWW, 'não é json'), null);
  assert.equal(parseSignupEvent(WWW, `"${'a'.repeat(MAX_EVENT_TEXT_LENGTH)}"`), null);
  assert.equal(parseSignupEvent(WWW, 42), null);
  assert.equal(parseSignupEvent(WWW, null), null);
  assert.equal(parseSignupEvent(WWW, []), null);
  for (const extra of [
    { phone_number_id: 'abc' },
    { waba_id: '12 3' },
    { phone_number_id: '1'.repeat(33) },
    { phone_number_id: 123 },
    { waba_id: null },
    { waba_id: '../x' },
  ]) {
    assert.equal(parseSignupEvent(WWW, JSON.stringify(finish(extra))), null);
  }
  assert.equal(
    parseSignupEvent(WWW, JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH' })),
    null,
  );
  assert.equal(
    parseSignupEvent(WWW, JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'DESCONHECIDO' })),
    null,
  );
});

test('parser: CANCEL, ERROR e variantes de FINISH viram estados distintos', () => {
  const event = (name: string) =>
    JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: name, data: { current_step: 'x' } });
  assert.deepEqual(parseSignupEvent(WWW, event('CANCEL')), { kind: 'cancel' });
  assert.deepEqual(parseSignupEvent(WWW, event('ERROR')), { kind: 'error' });
  for (const variant of [
    'FINISH_ONLY_WABA',
    'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    'FINISH_GRANT_ONLY_API_ACCESS',
  ]) {
    assert.deepEqual(parseSignupEvent(WWW, event(variant)), { kind: 'unsupported' });
  }
});

const run = (
  inputs: readonly (readonly [number, SignupInput])[],
  from: SignupState = INITIAL_SIGNUP_STATE,
): { state: SignupState; effects: NonNullable<SignupEffect>[] } => {
  let state = from;
  const effects: NonNullable<SignupEffect>[] = [];
  for (const [now, input] of inputs) {
    const step = stepSignup(state, input, now);
    state = step.state;
    if (step.effect !== null) effects.push(step.effect);
  }
  return { state, effects };
};
const ids = { kind: 'finish', phoneNumberId: '111', wabaId: '222' } as const;

test('máquina: envia só com code E ids, nas duas ordens de chegada', () => {
  for (const order of ['code-primeiro', 'ids-primeiro'] as const) {
    const code = [1_500, { type: 'code', code: 'C1' }] as const;
    const event = [2_000, { type: 'event', event: ids }] as const;
    const first = order === 'code-primeiro' ? code : event;
    const second = order === 'code-primeiro' ? event : code;
    const afterFirst = run([[0, { type: 'start' }], first]);
    assert.equal(afterFirst.effects.length, 0, `${order}: nada com só uma metade`);
    assert.equal(afterFirst.state.phase, 'waiting');
    const done = run([second], afterFirst.state);
    assert.deepEqual(done.effects, [
      { type: 'submit', code: 'C1', wabaId: '222', phoneNumberId: '111' },
    ]);
    assert.equal(done.state.phase, 'submitting');
    assert.equal(done.state.code, null);
    assert.equal(done.state.ids, null);
  }
});

test('máquina: 10 s com só uma metade = falha sem enviar; code com mais de 20 s nunca é enviado', () => {
  const onlyCode = run([
    [0, { type: 'start' }],
    [1_000, { type: 'code', code: 'C1' }],
  ]);
  assert.equal(
    run([[1_000 + OTHER_HALF_TIMEOUT_MS, { type: 'tick' }]], onlyCode.state).state.phase,
    'waiting',
  );
  const late = run([[1_001 + OTHER_HALF_TIMEOUT_MS, { type: 'tick' }]], onlyCode.state);
  assert.equal(late.state.phase, 'failed');
  assert.equal(late.state.failure, 'timeout');
  assert.equal(late.state.code, null);
  assert.equal(late.effects.length, 0);

  const onlyIds = run([
    [0, { type: 'start' }],
    [1_000, { type: 'event', event: ids }],
    [1_000 + OTHER_HALF_TIMEOUT_MS + 1, { type: 'tick' }],
  ]);
  assert.equal(onlyIds.state.failure, 'timeout');

  // Se a outra metade chega depois do prazo (sem tick no meio), também não envia.
  const tooLate = run([
    [0, { type: 'start' }],
    [1_000, { type: 'code', code: 'C1' }],
    [1_000 + CODE_MAX_AGE_MS + 1, { type: 'event', event: ids }],
  ]);
  assert.equal(tooLate.effects.length, 0);
  assert.equal(tooLate.state.failure, 'timeout');
  const farApart = run([
    [0, { type: 'start' }],
    [1_000, { type: 'event', event: ids }],
    [1_000 + OTHER_HALF_TIMEOUT_MS + 1, { type: 'code', code: 'C1' }],
  ]);
  assert.equal(farApart.effects.length, 0);
});

test('máquina: segunda tentativa não reaproveita code nem ids da anterior', () => {
  const failed = run([
    [0, { type: 'start' }],
    [1_000, { type: 'code', code: 'VELHO' }],
    [20_000, { type: 'tick' }],
  ]);
  assert.equal(failed.state.phase, 'failed');
  const second = run(
    [
      [30_000, { type: 'start' }],
      [31_000, { type: 'event', event: ids }],
    ],
    failed.state,
  );
  assert.equal(second.effects.length, 0, 'sem o code velho');
  assert.equal(second.state.code, null);
  const sent = run([[32_000, { type: 'code', code: 'NOVO' }]], second.state);
  assert.equal(sent.effects[0]?.code, 'NOVO');
});

test('máquina: cancelamento, erro, variante e popup bloqueado terminam sem enviar e zeram tudo', () => {
  const started = run([[0, { type: 'start' }]]).state;
  const cases: [SignupInput, SignupState['phase'], SignupState['failure']][] = [
    [{ type: 'code', code: null }, 'cancelled', null],
    [{ type: 'event', event: { kind: 'cancel' } }, 'cancelled', null],
    [{ type: 'event', event: { kind: 'error' } }, 'failed', 'error'],
    [{ type: 'event', event: { kind: 'unsupported' } }, 'failed', 'unsupported'],
    [{ type: 'popup_blocked' }, 'failed', 'popup_blocked'],
  ];
  for (const [input, phase, failure] of cases) {
    const result = run([[100, input]], started);
    assert.equal(result.state.phase, phase);
    assert.equal(result.state.failure, failure);
    assert.equal(result.state.code, null);
    assert.equal(result.state.ids, null);
    assert.equal(result.effects.length, 0);
  }
});

test('máquina: evento fora da tentativa, repetido ou depois da conclusão é ignorado', () => {
  assert.equal(
    run([[0, { type: 'event', event: ids }]]).state.ids,
    null,
    'em idle nada é guardado',
  );
  const submitted = run([
    [0, { type: 'start' }],
    [1, { type: 'code', code: 'C1' }],
    [2, { type: 'event', event: ids }],
  ]);
  assert.equal(submitted.effects.length, 1);
  const again = run(
    [
      [3, { type: 'event', event: ids }],
      [4, { type: 'code', code: 'C2' }],
    ],
    submitted.state,
  );
  assert.equal(again.effects.length, 0, 'não envia duas vezes');
  assert.equal(again.state.phase, 'submitting');
  // O resultado do envio fecha a tentativa e zera tudo.
  assert.equal(run([[5, { type: 'submitted', ok: true }]], submitted.state).state.phase, 'done');
  const failed = run([[5, { type: 'submitted', ok: false }]], submitted.state).state;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.code, null);
  // Depois de done, um evento tardio não faz nada.
  const done = run([[5, { type: 'submitted', ok: true }]], submitted.state).state;
  assert.equal(run([[6, { type: 'event', event: ids }]], done).state, done);
  // Um segundo code na mesma tentativa é ignorado.
  const twice = run([
    [0, { type: 'start' }],
    [1, { type: 'code', code: 'C1' }],
    [2, { type: 'code', code: 'C2' }],
    [3, { type: 'event', event: ids }],
  ]);
  assert.equal(twice.effects[0]?.code, 'C1');
});

test('máquina: reset (troca de empresa, desmontagem) zera code e ids', () => {
  const mid = run([
    [0, { type: 'start' }],
    [1, { type: 'code', code: 'C1' }],
    [2, { type: 'reset' }],
  ]);
  assert.deepEqual(mid.state, INITIAL_SIGNUP_STATE);
});
