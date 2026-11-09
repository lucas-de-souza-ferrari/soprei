import type { CompanyId } from '../value-objects/company-id.js';
import type { MembershipId } from '../value-objects/membership-id.js';
import type { AccountId } from '../value-objects/account-id.js';
import type { MembershipRole } from '../entities/membership.js';
import type { CompanyBillingPolicy } from './billing.repository.js';

export interface Account {
  readonly id: AccountId;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly emailVerifiedAt: Date | null;
}

export interface AccountMembership {
  readonly companyId: CompanyId;
  readonly membershipId: MembershipId;
  readonly name: string;
  readonly role: MembershipRole;
}

/** Erros seguidos que matam o código vigente (spec 020). */
export const VERIFICATION_MAX_ATTEMPTS = 5;
/** Erros acumulados na janela de 24 h, por conta, que bloqueiam código novo (spec 020, decisão 8). */
export const VERIFICATION_DAILY_FAILURE_CAP = 25;
export const VERIFICATION_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** Erros seguidos que matam o código de recuperação vigente (spec 021). */
export const RESET_MAX_ATTEMPTS = 5;
/** Erros acumulados na janela de 24 h, por conta, que bloqueiam código de recuperação novo. */
export const RESET_DAILY_FAILURE_CAP = 10;
export const RESET_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Resultado de um erro registrado contra o código de recuperação. `unavailable`: não há código
 * vigente (ausente, vencido, esgotado, conta inexistente, não confirmada ou desativada).
 */
export type ResetFailureOutcome = 'wrong' | 'exhausted' | 'unavailable';

/**
 * Resultado de uma tentativa de confirmar o e-mail. Só métrica e log interno: a resposta ao
 * empresa é uma só. `unavailable`: sem código vigente (ausente, vencido, esgotado, conta já
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
  /**
   * Grava um código de recuperação (já em HMAC) numa única instrução, casando por e-mail: só conta
   * confirmada e ativa, fora do intervalo mínimo (`retryBefore`) e do teto diário de erros. Devolve
   * o id só quando algo foi gravado; `null` é uniforme para todos os outros casos.
   */
  issueResetCode(
    email: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
    now: Date,
  ): Promise<string | null>;
  /** Confere sem consumir: há código vigente igual a `hash` para essa conta? */
  hasValidResetCode(email: string, hash: string, now: Date): Promise<boolean>;
  /**
   * Registra um erro contra o código vigente (atômico): o 5º erro do código ou o 10º do dia apaga o
   * hash e mantém o vencimento.
   */
  recordResetFailure(email: string, now: Date): Promise<ResetFailureOutcome>;
  /**
   * Troca a senha e gasta o código na mesma instrução. `false` = o código não casava mais (outro
   * pedido venceu, esgotou, venceu o prazo ou a conta não está apta).
   */
  resetPassword(email: string, hash: string, passwordHash: string, now: Date): Promise<boolean>;
  /** Descarta o código que não chegou a sair (falha de envio), liberando novo pedido já. */
  clearResetCode(id: string, hash: string): Promise<void>;
  listMemberships(accountId: string): Promise<readonly AccountMembership[]>;
  membership(accountId: string, companyId: CompanyId): Promise<AccountMembership | null>;
  /**
   * Cria a empresa com o vínculo `OWNER`. Com `billing` (spec 031, cobrança ligada) a mesma transação que trava
   * a conta garante a assinatura, confere acesso e limite de empresas do plano e grava `subscriptionId`.
   */
  createCompany(
    accountId: string,
    name: string,
    billing?: CompanyBillingPolicy,
  ): Promise<AccountMembership>;
  /** Última empresa selecionada pela conta (spec 029): só uma dica, sempre revalidada contra os vínculos. */
  lastCompanyId(accountId: string): Promise<string | null>;
  /** Grava a dica da última empresa (spec 029); quem chama já conferiu o vínculo. */
  setLastCompany(accountId: string, companyId: CompanyId): Promise<void>;
}

/** Expurgo de contas nunca confirmadas (spec 021). */
export interface UnverifiedAccountPurgeRepository {
  /**
   * Apaga até `batchSize` contas **não confirmadas**, sem nenhum vínculo (`Membership`) e com
   * `updated_at` anterior a `cutoff`. O predicado é repetido no DELETE sob lock, então conta
   * confirmada ou com vínculo nunca é apagada. Devolve só a contagem.
   */
  purgeUnverified(cutoff: Date, batchSize: number): Promise<number>;
}
