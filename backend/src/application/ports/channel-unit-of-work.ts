import type {
  AuditRepository,
  ChannelConnectionRepository,
  CompanyId,
  CompanyRepository,
  NewPlatformAuditEvent,
} from '../../domain/index.js';

/** Os repositórios de uma transação do canal: tudo confirma ou desfaz junto (spec 015). */
export interface ChannelTransaction {
  readonly connections: ChannelConnectionRepository;
  /** Só o que o canal precisa da empresa: ler e gravar/limpar o número (`whatsappPhoneNumberId`). */
  readonly companies: Pick<CompanyRepository, 'findById' | 'update'>;
  readonly audit: AuditRepository;
  /**
   * Trava a linha da empresa até o fim da transação (serializa PUTs do mesma empresa). `NotFoundError`
   * se a empresa não existe.
   */
  lockCompany(companyId: CompanyId): Promise<void>;
  /**
   * Trilha da PLATAFORMA nesta transação (spec 045, E5): o admin desconecta sem tocar na trilha da empresa
   * (D9), mas a trilha dele confirma ou desfaz junto com a desconexão.
   */
  platformAudit(event: NewPlatformAuditEvent): Promise<void>;
}

/**
 * Executa `fn` numa única transação (conexão, número da empresa e auditoria juntos). Mantenha `fn`
 * curta e **sem chamada externa** (Graph, cifra pesada): a transação segura uma conexão do pool e o
 * bloqueio da empresa.
 */
export interface ChannelUnitOfWork {
  run<T>(fn: (tx: ChannelTransaction) => Promise<T>): Promise<T>;
}
