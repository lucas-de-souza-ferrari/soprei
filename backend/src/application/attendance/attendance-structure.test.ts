import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as attendance from './attendance.service.js';

// Spec 035, E4: o `attendance.service.ts` foi dividido (tipos, prompt, chamada ao modelo e atendimento
// humano em arquivos próprios). Este teste falha se o serviço voltar a inchar, se a interface pública
// da classe mudar ou se o módulo deixar de exportar o que os chamadores importam dele.
const read = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

const SERVICE_MAX_LINES = 900;

/** Métodos públicos da classe: linhas de dois espaços que começam um método sem `private`. */
function publicMethods(source: string): string[] {
  const start = source.indexOf('\nexport class AttendanceService {');
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}(?:async )?([a-zA-Z]+)\(/gm)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== 'constructor');
}

describe('divisão do attendance.service.ts (spec 035, E4)', () => {
  it(`o serviço tem menos de ${String(SERVICE_MAX_LINES)} linhas`, () => {
    const lines = read('attendance.service.ts').split('\n').length;
    assert.ok(lines < SERVICE_MAX_LINES, `attendance.service.ts tem ${String(lines)} linhas`);
  });

  it('a classe mantém a mesma interface pública', () => {
    assert.deepEqual(publicMethods(read('attendance.service.ts')).sort(), [
      'acceptInboundMessage',
      'activePause',
      'getConversationsByIds',
      'handleInboundMessage',
      'hasPendingMessages',
      'isAiPausedFor',
      'listConversations',
      'listMessages',
      'recordHumanEcho',
      'respondToPending',
      'resumeAi',
    ]);
  });

  it('o módulo continua exportando o que os chamadores importam dele', () => {
    assert.equal(typeof attendance.AttendanceService, 'function');
    assert.equal(typeof attendance.buildSystemPrompt, 'function');
    assert.equal(typeof attendance.humanEchoContent, 'function');
    assert.equal(typeof attendance.ATTENDANCE_FALLBACK_TEXT, 'string');
    assert.equal(typeof attendance.ATTENDANCE_STYLE_INSTRUCTION, 'string');
    assert.equal(typeof attendance.RECEIVED_AT_MAX_PAST_MS, 'number');
    assert.equal(typeof attendance.RECEIVED_AT_MAX_FUTURE_MS, 'number');
  });

  it('cada parte mora no próprio arquivo e o serviço só a usa por composição', () => {
    assert.match(read('attendance-llm.ts'), /^export class AttendanceLlm \{$/m);
    assert.match(read('attendance-prompt.ts'), /^export class AttendancePrompt \{$/m);
    assert.match(read('attendance-takeover.ts'), /^export class AttendanceTakeover \{$/m);
    assert.match(read('attendance.types.ts'), /^export interface AttendanceDeps \{$/m);
    const service = read('attendance.service.ts');
    for (const part of ['AttendanceLlm', 'AttendancePrompt', 'AttendanceTakeover']) {
      assert.match(service, new RegExp(`= new ${part}\\(`), part);
    }
    // A chamada ao provedor e a montagem do prompt não voltaram para o serviço.
    assert.doesNotMatch(service, /this\.deps\.llm\.generate\(/);
    assert.doesNotMatch(service, /buildKnowledgePrompt\(|buildSchedulePrompt\(/);
  });
});
