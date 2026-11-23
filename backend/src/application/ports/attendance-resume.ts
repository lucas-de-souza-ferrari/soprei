/** Por que o contato entrou na retomada (spec 035): mensagem sem resposta ou resposta não enviada. */
export type ResumeKind = 'pending' | 'unsent';

/** Contato do canal de uma empresa cujo atendimento ficou pelo caminho. */
export interface ResumeTarget {
  readonly companyId: string;
  /** Número do negócio que a empresa usa hoje (lido do banco, nunca de job antigo). */
  readonly phoneNumberId: string;
  /** Vai só para dentro do job de `flush`; nunca a log nem a métrica. */
  readonly contactRef: string;
  readonly kind: ResumeKind;
}

export interface ResumeScanOptions {
  readonly now: Date;
  /** Só o que está parado há pelo menos isto. */
  readonly minAgeMs: number;
  /** Só contatos cuja mensagem mais recente tem menos que isto (janela de atendimento do canal). */
  readonly windowMs: number;
  /** Empresas lidas nesta chamada, a partir de `afterCompanyId` (rodízio). */
  readonly maxCompanies: number;
  /** Contatos lidos por empresa e por tipo. */
  readonly maxContactsPerCompany: number;
  /** Id da última empresa lida na chamada anterior; `null` começa do início. */
  readonly afterCompanyId: string | null;
}

export interface ResumeScan {
  readonly targets: readonly ResumeTarget[];
  /** Cursor da próxima chamada; `null` quando a lista de empresas acabou (a próxima recomeça). */
  readonly nextCompanyId: string | null;
}

/**
 * Quem ficou sem resposta no canal (spec 035). Percorre as empresas ativas com número conectado e
 * credencial válida e, para cada uma, consulta as conversas **com o `companyId` no filtro** (barreira
 * de tenant). Fora: IA pausada na conversa, contato fixo do teste do site, o que é recente demais e o
 * que saiu da janela.
 */
export interface ResumeTargetReader {
  scan(options: ResumeScanOptions): Promise<ResumeScan>;
}

/**
 * Contador de retomadas por contato (spec 035, D3). `take` consome uma tentativa e devolve `false`
 * quando o contato já gastou as dele na janela. A chave deriva do `companyId` e de um hash do contato
 * (nunca o telefone). Indisponível = lança: a varredura não agenda sem conseguir contar.
 */
export interface ResumeAttemptStore {
  take(companyId: string, contactRef: string): Promise<boolean>;
}
