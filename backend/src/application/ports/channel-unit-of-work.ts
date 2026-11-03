import type {
  AuditRepository,
  ChannelConnectionRepository,
  ClientId,
  ClientRepository,
} from '../../domain/index.js';

/** Os repositórios de uma transação do canal: tudo confirma ou desfaz junto (spec 015). */
export interface ChannelTransaction {
  readonly connections: ChannelConnectionRepository;
  /** Só o que o canal precisa do cliente: ler e gravar/limpar o número (`whatsappPhoneNumberId`). */
  readonly clients: Pick<ClientRepository, 'findById' | 'update'>;
  readonly audit: AuditRepository;
  /**
   * Trava a linha do cliente até o fim da transação (serializa PUTs do mesmo cliente). `NotFoundError`
   * se o cliente não existe.
   */
  lockClient(clientId: ClientId): Promise<void>;
}

/**
 * Executa `fn` numa única transação (conexão, número do cliente e auditoria juntos). Mantenha `fn`
 * curta e **sem chamada externa** (Graph, cifra pesada): a transação segura uma conexão do pool e o
 * bloqueio do cliente.
 */
export interface ChannelUnitOfWork {
  run<T>(fn: (tx: ChannelTransaction) => Promise<T>): Promise<T>;
}
