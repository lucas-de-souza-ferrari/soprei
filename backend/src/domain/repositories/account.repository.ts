import type { ClientId } from '../value-objects/client-id.js';
import type { UserId } from '../value-objects/user-id.js';
import type { AccountId } from '../value-objects/user-id.js';
import type { UserRole } from '../entities/user.js';

export interface Account {
  readonly id: AccountId;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly emailVerifiedAt: Date | null;
}

export interface AccountMembership {
  readonly clientId: ClientId;
  readonly userId: UserId;
  readonly name: string;
  readonly role: UserRole;
}

/** Erros seguidos que matam o código vigente (spec 020). */
export const VERIFICATION_MAX_ATTEMPTS = 5;
/** Erros acumulados na janela de 24 h, por conta, que bloqueiam código novo (spec 020, decisão 8). */
export const VERIFICATION_DAILY_FAILURE_CAP = 25;
export const VERIFICATION_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Resultado de uma tentativa de confirmar o e-mail. Só métrica e log interno: a resposta ao
 * cliente é uma só. `unavailable`: sem código vigente (ausente, vencido, esgotado, conta já
 * confirmada ou inativa).
 */
export type VerifyOutcome = 'verified' | 'wrong' | 'exhausted' | 'unavailable';

/** Única resolução de conta global para empresas; não devolve dados de negócio. */
export interface AccountRepository {
  findByEmail(email: string): Promise<Account | null>;
  findById(id: AccountId): Promise<Account | null>;
  create(email: string, passwordHash: string): Promise<Account>;
  /**
   * Cadastro público em uma única instrução atômica: cria a conta ainda não confirmada ou, se o
   * e-mail já existe **e continua sem confirmação**, substitui o hash da senha e a verificação
   * (o código anterior deixa de valer e o contador de erros do código zera). Conta confirmada,
   * desativada, com envio feito depois de `retryBefore` ou com o teto diário de erros estourado
   * (24 h até `now`) não muda. Devolve o id só quando algo foi gravado (e, portanto, um código
   * deve ser enviado); `null` é uniforme para "já confirmada", "cedo demais" e "teto diário".
   */
  registerUnverified(input: {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly verificationHash: string;
    readonly expiresAt: Date;
    readonly retryBefore: Date;
    readonly now: Date;
  }): Promise<string | null>;
  /**
   * Novo código para conta não confirmada, respeitando o intervalo mínimo e o teto diário de
   * erros; sem trocar a senha. Zera o contador de erros do código (não o diário).
   */
  refreshVerification(
    id: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
    now: Date,
  ): Promise<boolean>;
  /** Descarta o código enviado que não chegou a sair (falha de envio), liberando novo envio já. */
  clearVerification(id: string, hash: string): Promise<void>;
  setVerification(id: string, hash: string, expiresAt: Date): Promise<void>;
  /**
   * Confere o código (já em HMAC) de forma atômica: sucesso confirma e zera os contadores; erro
   * incrementa o contador do código vigente, que morre no 5º erro (ou no 25º do dia) mantendo o
   * vencimento, de modo que o intervalo mínimo de reenvio continua valendo.
   */
  verify(id: string, hash: string, now: Date): Promise<VerifyOutcome>;
  listMemberships(accountId: string): Promise<readonly AccountMembership[]>;
  membership(accountId: string, clientId: ClientId): Promise<AccountMembership | null>;
  createCompany(accountId: string, name: string): Promise<AccountMembership>;
}
