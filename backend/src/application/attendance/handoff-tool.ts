import { HANDOFF_REASONS, type HandoffReason, isHandoffReason } from '../../domain/index.js';
import {
  LLM_TOOL_RESULT_UNAVAILABLE,
  type LlmToolCall,
  type LlmToolDefinition,
  type LlmToolOutput,
  type LlmToolSet,
} from '../ports/llm-provider.js';
import type { ScheduleToolSet } from './schedule-tools.js';

/**
 * Pedido de atendimento humano como ferramenta (spec 038), no mesmo mecanismo de ferramentas da 028. A
 * ferramenta **não executa nada para o contato**: só registra, em memória do turno, que o modelo pediu uma
 * pessoa e com qual motivo (lista fixa). Quem grava a notificação é o atendimento, na transação da resposta.
 * O resultado devolvido ao modelo é texto fixo do servidor; o modelo segue e escreve a resposta.
 */
export const HANDOFF_TOOL_NAME = 'solicitar_atendimento_humano';

export const HANDOFF_TOOL_DEFINITION: LlmToolDefinition = {
  name: HANDOFF_TOOL_NAME,
  description:
    'Avisa a equipe da empresa que esta conversa precisa de atendimento humano. Use só quando o contato pedir para falar com uma pessoa ou quando você não puder resolver o pedido (assunto fora do que você sabe, reclamação, urgência ou assunto sensível). Não use em conversas comuns que você consegue atender. Depois, diga ao contato que a equipe foi avisada; nunca prometa prazo e nunca diga que uma pessoa já está na conversa.',
  inputSchema: {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        enum: [...HANDOFF_REASONS],
        description:
          'CONTACT_REQUESTED: o contato pediu uma pessoa; CANNOT_HELP: fora do que você sabe ou pode fazer; COMPLAINT: reclamação ou insatisfação; SENSITIVE: urgência, saúde, jurídico ou financeiro; OTHER: outro motivo.',
      },
    },
    required: ['motivo'],
    additionalProperties: false,
  },
};

/** Resultado fixo devolvido ao modelo (texto do servidor; nunca do contato). */
export const HANDOFF_TOOL_OUTPUT: LlmToolOutput = {
  content:
    'registrado: a equipe da empresa foi avisada. Diga ao contato que uma pessoa da equipe vai falar com ele, sem prometer prazo.',
  isError: false,
};

/** Tetos do turno quando só a ferramenta de humano é oferecida (uma chamada e a resposta). */
const HANDOFF_ONLY_LIMITS = { maxModelCalls: 2, maxToolCalls: 2 } as const;

export interface HandoffRecorder {
  readonly definition: LlmToolDefinition;
  execute(call: LlmToolCall): LlmToolOutput;
  /** O primeiro motivo pedido neste turno, ou `undefined` se o modelo não pediu humano. */
  requested(): HandoffReason | undefined;
}

/**
 * Um registrador por turno. Várias chamadas contam como uma (fica o primeiro motivo); motivo ausente ou fora
 * da lista vira `OTHER` (o modelo quis uma pessoa; o motivo é secundário). O argumento nunca vai a log.
 */
export function createHandoffRecorder(): HandoffRecorder {
  let reason: HandoffReason | undefined;
  return {
    definition: HANDOFF_TOOL_DEFINITION,
    execute(call) {
      reason ??= reasonOf(call.input);
      return HANDOFF_TOOL_OUTPUT;
    },
    requested: () => reason,
  };
}

function reasonOf(input: unknown): HandoffReason {
  if (typeof input === 'object' && input !== null && 'motivo' in input) {
    const motivo: unknown = input.motivo;
    if (isHandoffReason(motivo)) return motivo;
  }
  return 'OTHER';
}

/**
 * Junta as ferramentas do turno num único conjunto para o provedor: as da agenda (se houver) e a de
 * humano. A de humano é despachada aqui; as demais vão ao executor da agenda. Sem agenda, os tetos são os
 * de uma chamada e a resposta; com agenda, os dela com uma chamada de ferramenta a mais.
 */
export function composeToolSet(
  handoff: HandoffRecorder,
  schedule: ScheduleToolSet | undefined,
): LlmToolSet {
  const scheduleSet = schedule?.toolSet;
  return {
    definitions: [...(scheduleSet?.definitions ?? []), handoff.definition],
    execute(call) {
      if (call.name === HANDOFF_TOOL_NAME) return Promise.resolve(handoff.execute(call));
      if (scheduleSet === undefined) return Promise.resolve(LLM_TOOL_RESULT_UNAVAILABLE);
      return scheduleSet.execute(call);
    },
    limits:
      scheduleSet === undefined
        ? HANDOFF_ONLY_LIMITS
        : {
            maxModelCalls: scheduleSet.limits.maxModelCalls,
            maxToolCalls: scheduleSet.limits.maxToolCalls + 1,
          },
  };
}
