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

/** Nomes fixos das ferramentas (português, sem acento). Só a leitura existe na E1. */
export const SCHEDULE_AI_TOOL_LIST_SLOTS = 'listar_horarios';
export const SCHEDULE_AI_TOOL_NAMES = [SCHEDULE_AI_TOOL_LIST_SLOTS] as const;
