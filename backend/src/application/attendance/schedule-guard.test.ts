import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCHEDULE_AI_SAFE_REPLY } from '../../domain/index.js';
import { claimsDone, finalizeScheduleReply } from './schedule-guard.js';

describe('guarda de afirmação (spec 028, decisão 7)', () => {
  it('pega as frases fixas, com ou sem acento e maiúscula', () => {
    for (const text of [
      'Marquei seu horário!',
      'Pronto, AGENDEI para quinta.',
      'Eu reservei o horário.',
      'Já cancelei o seu.',
      'Remarquei para sexta.',
      'Seu horário está marcado para as 10h.', // "esta marcado" sem acento ("está" normaliza)
      'Ficou marcado para amanhã.',
      'Agendado para terça às 14:00.',
      'Confirmado para sexta.',
      'Fica combinado então!',
      'Pode vir às 14h.',
      'Te espero amanhã.',
      'Reserva feita para quinta.',
    ]) {
      assert.equal(claimsDone(text), true, text);
    }
  });

  it('não confunde pergunta, oferta e negação', () => {
    for (const text of [
      'Quer que eu marque para as 14:00?',
      'Posso agendar para quinta?',
      'Não marquei nada ainda.',
      'Não consegui agendar esse horário.',
      'Qual serviço você quer?',
      'A equipe vai confirmar o seu pedido.',
    ]) {
      assert.equal(claimsDone(text), false, text);
    }
  });

  it('sem escrita: afirmação vira o texto seguro; com escrita: o resumo é acrescentado só se faltar a hora', () => {
    assert.deepEqual(finalizeScheduleReply('Marquei!', [], 4000), {
      text: SCHEDULE_AI_SAFE_REPLY,
      kind: 'guard_replaced',
    });
    assert.deepEqual(finalizeScheduleReply('Qual dia?', [], 4000), {
      text: 'Qual dia?',
      kind: 'as_is',
    });
    const writes = [{ summary: 'Pedido registrado: X às 09:00.', times: ['09:00'] }];
    assert.deepEqual(finalizeScheduleReply('Anotado para 09:00.', writes, 4000), {
      text: 'Anotado para 09:00.',
      kind: 'as_is',
    });
    const added = finalizeScheduleReply('Anotado!', writes, 4000);
    assert.equal(added.kind, 'deterministic_summary');
    assert.equal(added.text, 'Anotado!\n\nPedido registrado: X às 09:00.');
    // Não cabe no teto: fica só o resumo.
    assert.equal(finalizeScheduleReply('x'.repeat(50), writes, 60).text, writes[0]?.summary);
  });
});
