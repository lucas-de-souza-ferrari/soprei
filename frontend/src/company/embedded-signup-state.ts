import type { SignupEvent } from './embedded-signup-event';

/**
 * Máquina de estados de uma tentativa de Embedded Signup (spec 023), pura e sem relógio próprio:
 * quem chama passa `now` (ms). O `code` (callback do `FB.login`) e os ids (evento `FINISH`) chegam por
 * canais diferentes e em ordem não garantida; só se envia quando se tem os dois. O `code` vale cerca de
 * 30 s e é de uso único, então um `code` velho nunca é enviado (o servidor responderia
 * `CHANNEL_CODE_INVALID`).
 *
 * `idle -> waiting -> submitting -> done | failed`, mais `cancelled`. O `code` e os ids existem só dentro
 * do estado `waiting` e do efeito `submit`; todo outro estado os zera.
 */
export const OTHER_HALF_TIMEOUT_MS = 10_000;
export const CODE_MAX_AGE_MS = 20_000;

export type SignupFailure = 'timeout' | 'error' | 'unsupported' | 'popup_blocked';

/** Spec 039: `api_only` (número novo, o fluxo da 023) ou `coexistence` (aplicativo no celular). */
export type SignupMode = 'api_only' | 'coexistence';

export interface SignupState {
  readonly phase: 'idle' | 'waiting' | 'submitting' | 'done' | 'failed' | 'cancelled';
  /** O fluxo da tentativa em andamento (spec 039); decide qual evento de fim vale. */
  readonly mode: SignupMode;
  readonly code: { readonly value: string; readonly at: number } | null;
  readonly ids: {
    readonly wabaId: string;
    /** `null` só na coexistência (o servidor resolve pelo número único da WABA). */
    readonly phoneNumberId: string | null;
    readonly at: number;
  } | null;
  /** Por que falhou, quando `phase === 'failed'`. */
  readonly failure: SignupFailure | null;
}

export type SignupInput =
  | { readonly type: 'start'; readonly mode?: SignupMode }
  /** `null`: o callback do `FB.login` veio sem `authResponse.code` (cancelamento). */
  | { readonly type: 'code'; readonly code: string | null }
  | { readonly type: 'event'; readonly event: SignupEvent }
  | { readonly type: 'popup_blocked' }
  | { readonly type: 'tick' }
  | { readonly type: 'submitted'; readonly ok: boolean }
  | { readonly type: 'reset' };

export type SignupEffect = {
  readonly type: 'submit';
  readonly mode: SignupMode;
  readonly code: string;
  readonly wabaId: string;
  readonly phoneNumberId: string | null;
} | null;

export const INITIAL_SIGNUP_STATE: SignupState = {
  phase: 'idle',
  mode: 'api_only',
  code: null,
  ids: null,
  failure: null,
};

const fail = (failure: SignupFailure, mode: SignupMode): SignupState => ({
  phase: 'failed',
  mode,
  code: null,
  ids: null,
  failure,
});

const cancelled = (mode: SignupMode): SignupState => ({
  ...INITIAL_SIGNUP_STATE,
  phase: 'cancelled',
  mode,
});

/** Tenta enviar: só com `code` **e** ids, e com o `code` ainda novo. */
function trySubmit(state: SignupState, now: number): { state: SignupState; effect: SignupEffect } {
  if (state.code === null || state.ids === null) return { state, effect: null };
  if (
    now - state.code.at > CODE_MAX_AGE_MS ||
    Math.abs(state.code.at - state.ids.at) > OTHER_HALF_TIMEOUT_MS
  ) {
    return { state: fail('timeout', state.mode), effect: null };
  }
  return {
    state: { phase: 'submitting', mode: state.mode, code: null, ids: null, failure: null },
    effect: {
      type: 'submit',
      mode: state.mode,
      code: state.code.value,
      wabaId: state.ids.wabaId,
      phoneNumberId: state.ids.phoneNumberId,
    },
  };
}

export function stepSignup(
  state: SignupState,
  input: SignupInput,
  now: number,
): { state: SignupState; effect: SignupEffect } {
  const same = { state, effect: null } as const;
  if (input.type === 'reset') return { state: INITIAL_SIGNUP_STATE, effect: null };
  if (input.type === 'start') {
    // Uma tentativa nova nunca reaproveita `code` nem ids da anterior.
    return state.phase === 'waiting' || state.phase === 'submitting'
      ? same
      : {
          state: { ...INITIAL_SIGNUP_STATE, phase: 'waiting', mode: input.mode ?? 'api_only' },
          effect: null,
        };
  }
  if (input.type === 'submitted') {
    if (state.phase !== 'submitting') return same;
    return {
      state: input.ok
        ? { ...INITIAL_SIGNUP_STATE, phase: 'done', mode: state.mode }
        : { ...INITIAL_SIGNUP_STATE, phase: 'failed', mode: state.mode, failure: 'error' },
      effect: null,
    };
  }
  // Tudo o que sobra só vale com a tentativa em andamento: evento fora dela, repetido ou depois da
  // conclusão é ignorado.
  if (state.phase !== 'waiting') return same;
  switch (input.type) {
    case 'popup_blocked':
      return { state: fail('popup_blocked', state.mode), effect: null };
    case 'code':
      if (input.code === null) return { state: cancelled(state.mode), effect: null };
      if (state.code !== null) return same;
      return trySubmit({ ...state, code: { value: input.code, at: now } }, now);
    case 'event': {
      const { event } = input;
      if (event.kind === 'cancel') return { state: cancelled(state.mode), effect: null };
      if (event.kind === 'error') return { state: fail('error', state.mode), effect: null };
      // Spec 039: cada fluxo só aceita o próprio evento de fim; o do outro fluxo é "não suportado".
      const expected = state.mode === 'coexistence' ? 'finish_coexistence' : 'finish';
      if (event.kind === 'unsupported' || event.kind !== expected) {
        return { state: fail('unsupported', state.mode), effect: null };
      }
      if (state.ids !== null) return same;
      return trySubmit(
        {
          ...state,
          ids: { wabaId: event.wabaId, phoneNumberId: event.phoneNumberId, at: now },
        },
        now,
      );
    }
    case 'tick': {
      // Só um dos dois chegou e o outro não veio a tempo: descarta tudo sem enviar parcial.
      const first = state.code ?? state.ids;
      if (first !== null && now - first.at > OTHER_HALF_TIMEOUT_MS) {
        return { state: fail('timeout', state.mode), effect: null };
      }
      if (state.code !== null && now - state.code.at > CODE_MAX_AGE_MS) {
        return { state: fail('timeout', state.mode), effect: null };
      }
      return same;
    }
  }
}
