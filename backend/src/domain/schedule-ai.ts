/**
 * A IA e a agenda por ferramentas (spec 028). Constantes nomeadas (sem variável de ambiente, salvo a
 * chave global `SCHEDULE_AI_ENABLED`). Nada aqui guarda nome de serviço, horário nem contato.
 */

/** Chamadas ao modelo por turno com ferramentas: 3 rodadas de ferramenta mais a resposta final. */
export const SCHEDULE_AI_MAX_MODEL_CALLS = 4;
/** Chamadas de ferramenta por turno (a 7ª recebe `limite_turno`). */
export const SCHEDULE_AI_MAX_TOOL_CALLS = 6;
/** Prazo total do laço do turno (cada chamada ao modelo segue com o prazo de `LLM_TIMEOUT_MS`). */
export const SCHEDULE_AI_TURN_TIMEOUT_MS = 30_000;
/** Cada leitura de ferramenta cai sob `statement_timeout` de 1,5 s (cancela no banco). */
export const SCHEDULE_AI_TOOL_READ_TIMEOUT_MS = 1_500;

/** `listar_horarios`: horários devolvidos e intervalo máximo de datas. */
export const SCHEDULE_AI_MAX_SLOTS_RESULT = 8;
export const SCHEDULE_AI_MAX_LIST_DAYS = 7;
/** Serviços ativos citados no resultado `servico_nao_encontrado`. */
export const SCHEDULE_AI_MAX_SERVICE_NAMES_RESULT = 5;
/** `<meus_agendamentos>`: agendamentos ativos futuros do contato mostrados à IA. */
export const SCHEDULE_AI_MAX_MY_APPOINTMENTS = 3;

/** Nomes fixos das ferramentas (português, sem acento). */
export const SCHEDULE_AI_TOOL_LIST_SLOTS = 'listar_horarios';
export const SCHEDULE_AI_TOOL_REQUEST = 'solicitar_agendamento';
export const SCHEDULE_AI_TOOL_CANCEL = 'cancelar_agendamento';
export const SCHEDULE_AI_TOOL_RESCHEDULE = 'remarcar_agendamento';
export const SCHEDULE_AI_TOOL_NAMES = [
  SCHEDULE_AI_TOOL_LIST_SLOTS,
  SCHEDULE_AI_TOOL_REQUEST,
  SCHEDULE_AI_TOOL_CANCEL,
  SCHEDULE_AI_TOOL_RESCHEDULE,
] as const;

/** Escrita (E2/E3): no máximo 1 escrita bem-sucedida por turno (a segunda recebe `limite_turno`). */
export const SCHEDULE_AI_MAX_WRITES_PER_TURN = 1;
/** Cada escrita roda sob `statement_timeout` de 3 s (cancela no banco; nunca abandonada por prazo de aplicação). */
export const SCHEDULE_AI_TOOL_WRITE_TIMEOUT_MS = 3_000;
/** Horários alternativos devolvidos quando o pedido colide. */
export const SCHEDULE_AI_MAX_ALTERNATIVES = 3;

/** Limites contra abuso (decisão 6): por contato, por empresa e janela das cotas. */
export const SCHEDULE_AI_CONTACT_MAX_ACTIVE = 2;
export const SCHEDULE_AI_CONTACT_MAX_CREATIONS_PER_DAY = 3;
export const SCHEDULE_AI_CONTACT_MAX_WRITES_PER_DAY = 8;
export const SCHEDULE_AI_COMPANY_MAX_WRITES_PER_DAY = 100;
export const SCHEDULE_AI_COMPANY_MAX_PENDING = 30;
export const SCHEDULE_AI_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Verbos de conclusão em primeira pessoa (sem acento, minúsculos): a guarda de afirmação (decisão 7). */
export const SCHEDULE_AI_CLAIM_PHRASES: readonly string[] = [
  'marquei',
  'agendei',
  'reservei',
  'cancelei',
  'remarquei',
  'esta marcado',
  'ficou marcado',
  'agendado para',
  'confirmado para',
];

/** Texto que troca uma resposta que afirma ter marcado algo sem escrita confirmada no turno. */
export const SCHEDULE_AI_SAFE_REPLY =
  'Não consegui concluir isso agora; a equipe confirma seu horário.';
