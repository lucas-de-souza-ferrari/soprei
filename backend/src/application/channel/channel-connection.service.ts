import { randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type AuditAction,
  type ChannelConnection,
  type ChannelConnectionRepository,
  type Company,
  type CompanyId,
  type CompanyRepository,
  hasPermission,
  type Permission,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  ValidationError,
} from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';
import type { MembershipIdentity } from '../auth/identity.js';
import type { ChannelUnitOfWork } from '../ports/channel-unit-of-work.js';
import {
  type ChannelProvisionError,
  type ChannelProvisioner,
} from '../ports/channel-provisioner.js';
import type { CredentialCipher } from '../ports/credential-cipher.js';

/** Escopos que todo token do canal precisa ter (spec 015). */
const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'] as const;

/** Códigos fixos dos 400/409 do canal; as mensagens são constantes (nunca ecoam entrada nem a Meta). */
export const CHANNEL_ERRORS = {
  CHANNEL_TOKEN_REJECTED: 'O token informado foi recusado pela Meta',
  CHANNEL_WRONG_APP: 'O token não pertence ao aplicativo do Soprei',
  CHANNEL_MISSING_SCOPE: 'O token não tem as permissões necessárias do WhatsApp',
  CHANNEL_NUMBER_NOT_IN_WABA: 'O número informado não pertence à conta WhatsApp Business do token',
  CHANNEL_NUMBER_IN_USE: 'Este número já está conectado a outra empresa',
  CHANNEL_CODE_INVALID: 'O código do Embedded Signup é inválido, expirou ou já foi usado',
  CHANNEL_REGISTRATION_FAILED: 'Não foi possível registrar o número na Meta',
} as const;
export type ChannelErrorCode = keyof typeof CHANNEL_ERRORS;

type MetricResult =
  | 'ok'
  | 'invalid_token'
  | 'wrong_app'
  | 'missing_scope'
  | 'number_not_in_waba'
  | 'number_in_use'
  | 'invalid_code'
  | 'registration_failed'
  | 'graph_error';

const RESULT_BY_CODE: Readonly<Record<ChannelErrorCode, MetricResult>> = {
  CHANNEL_TOKEN_REJECTED: 'invalid_token',
  CHANNEL_WRONG_APP: 'wrong_app',
  CHANNEL_MISSING_SCOPE: 'missing_scope',
  CHANNEL_NUMBER_NOT_IN_WABA: 'number_not_in_waba',
  CHANNEL_NUMBER_IN_USE: 'number_in_use',
  CHANNEL_CODE_INVALID: 'invalid_code',
  CHANNEL_REGISTRATION_FAILED: 'registration_failed',
};

export type ChannelState = 'NOT_CONNECTED' | 'CONNECTED' | 'TOKEN_INVALID' | 'LEGACY';

/** O que a API devolve do canal: nunca o token, o texto cifrado nem a chave. */
export interface ChannelStateView {
  readonly state: ChannelState;
  readonly phoneNumberId: string | null;
  readonly wabaId: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly connectedAt: Date | null;
  readonly tokenInvalidAt: Date | null;
}

export interface ConnectChannelInput {
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly accessToken: string;
}

/** Corpo do Embedded Signup: o `code` e os ids que o navegador entregou (não confiáveis). */
/** O que a prova de posse e a gravação usam: o número e a WABA (o token vem à parte). */
export type ChannelTarget = Pick<ConnectChannelInput, 'phoneNumberId' | 'wabaId'>;

export interface EmbeddedSignupInput {
  readonly code: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
}

export interface ChannelConnectionServiceDeps {
  /** Gera o PIN de 6 dígitos do registro; por padrão `crypto.randomInt` (CSPRNG). Só os testes trocam. */
  readonly generatePin?: () => string;
  readonly companies: Pick<CompanyRepository, 'findById' | 'findByWhatsappPhoneNumberId'>;
  readonly connections: Pick<ChannelConnectionRepository, 'find'>;
  readonly unitOfWork: ChannelUnitOfWork;
  readonly cipher: CredentialCipher;
  readonly provisioner: ChannelProvisioner;
  /** `WHATSAPP_APP_ID`: todo token precisa pertencer a este app. */
  readonly appId: string;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countChannelConnection' | 'countAuthzDenial'> | undefined;
}

interface PendingAudit {
  readonly action: AuditAction;
}

function toView(company: Company, connection: ChannelConnection | null): ChannelStateView {
  const number = company.whatsappPhoneNumberId;
  if (connection === null) {
    return {
      state: number === null ? 'NOT_CONNECTED' : 'LEGACY',
      phoneNumberId: number,
      wabaId: null,
      tokenExpiresAt: null,
      connectedAt: null,
      tokenInvalidAt: null,
    };
  }
  return {
    state: connection.status,
    phoneNumberId: number,
    wabaId: connection.wabaId,
    tokenExpiresAt: connection.tokenExpiresAt,
    connectedAt: connection.createdAt,
    tokenInvalidAt: connection.tokenInvalidAt,
  };
}

/**
 * Conexão do canal WhatsApp da própria empresa (spec 015): estado, conectar ou trocar o token
 * (`PUT`) e desconectar. O `CompanyId` vem sempre do ator (token de acesso). Antes de gravar, prova a
 * posse do número com o **token da própria empresa** (`debug_token` com `app_id` fixo, escopos, lista
 * de números da WABA e `subscribed_apps`); a gravação (cifra, conexão, número da empresa e
 * auditoria) é uma transação com a empresa travado. **Nunca** loga nem devolve token, texto cifrado,
 * número ou WABA: só ids internos e enums.
 */
export class ChannelConnectionService {
  constructor(private readonly deps: ChannelConnectionServiceDeps) {}

  async getState(actor: MembershipIdentity): Promise<ChannelStateView> {
    this.requirePermission(actor, 'channel:read');
    const [company, connection] = await Promise.all([
      this.deps.companies.findById(actor.companyId),
      this.deps.connections.find(actor.companyId),
    ]);
    return toView(company, connection);
  }

  /** Conecta ou troca o token (idempotente; também reconecta depois de `TOKEN_INVALID`). */
  async connect(actor: MembershipIdentity, input: ConnectChannelInput): Promise<ChannelStateView> {
    this.requirePermission(actor, 'channel:manage');
    const existing = await this.deps.connections.find(actor.companyId);
    const action = existing === null ? 'connect' : 'replace_token';
    const token = new SecretString(input.accessToken);
    try {
      const expiresAt = await this.proveOwnership(token, input);
      const outcome = await this.persist(actor, input, token, expiresAt);
      this.afterCommit(actor, [{ action: outcome.audit }]);
      this.count(action, 'ok');
      return outcome.view;
    } catch (error) {
      this.count(action, resultOf(error));
      throw error;
    }
  }

  /**
   * Embedded Signup (spec 015b): troca o `code` pelo token de negócio, faz a **mesma** prova de posse
   * do `PUT` (os ids do navegador não são confiados: valem só se a Graph os confirmar com o token
   * obtido), registra o número com um PIN aleatório de 6 dígitos gerado aqui (nunca visto nem
   * digitado pela empresa) e grava tudo cifrado, com auditoria, na mesma transação do `PUT`. Se o
   * `/register` falhar, **nada é gravado** (a empresa refaz o fluxo, que gera outro `code`). O `code`,
   * o token e o PIN nunca vão a log, erro, métrica nem resposta.
   */
  async embeddedSignup(
    actor: MembershipIdentity,
    input: EmbeddedSignupInput,
  ): Promise<ChannelStateView> {
    this.requirePermission(actor, 'channel:manage');
    try {
      const exchanged = await this.deps.provisioner.exchangeCode(new SecretString(input.code));
      if (!exchanged.ok) throw this.providerFailure(exchanged.error);
      const token = exchanged.value;
      const expiresAt = await this.proveOwnership(token, input);
      // Número de Outra empresa: 409 antes de registrar. Sem isto, um token que enxerga a WABA
      // compartilhada trocaria o PIN do número alheio pelo `/register`. (A corrida entre dois
      // empresas ainda é decidida pelo `@unique`, na transação.)
      const owner = await this.deps.companies.findByWhatsappPhoneNumberId(input.phoneNumberId);
      if (owner !== null && owner.id !== actor.companyId) throw channelConflict();
      const pin = await this.registrationPin(actor.companyId);
      const registered = await this.deps.provisioner.registerNumber(
        input.phoneNumberId,
        token,
        pin,
      );
      if (!registered.ok) throw this.providerFailure(registered.error);
      const outcome = await this.persist(
        actor,
        input,
        token,
        expiresAt,
        this.deps.cipher.encrypt(actor.companyId, pin),
      );
      this.afterCommit(actor, [{ action: outcome.audit }]);
      this.count('embedded_signup', 'ok');
      return outcome.view;
    } catch (error) {
      this.count('embedded_signup', resultOf(error));
      throw error;
    }
  }

  /**
   * PIN do registro: o que já está guardado para esta empresa (o número já foi registrado com ele e
   * registrar de novo com o mesmo PIN é aceito), senão um novo, aleatório. PIN guardado que não
   * decifra é ignorado, com `warn` só com o `companyId` (gera outro).
   */
  private async registrationPin(companyId: CompanyId): Promise<SecretString> {
    const existing = await this.deps.connections.find(companyId);
    if (existing?.registrationPinCiphertext != null) {
      try {
        return this.deps.cipher.decrypt(companyId, existing.registrationPinCiphertext);
      } catch {
        // Falha ao decifrar (chave removida, texto adulterado): segue com um PIN novo, mas avisa. O
        // log leva só o `companyId`: nada do PIN, do texto cifrado nem do erro.
        this.deps.logger.warn(
          { companyId },
          'PIN de registro guardado não pôde ser decifrado; gerando um PIN novo',
        );
      }
    }
    const generate = this.deps.generatePin ?? (() => randomInt(0, 1_000_000).toString());
    return new SecretString(generate().padStart(6, '0'));
  }

  /** Desconecta (idempotente): apaga a conexão, limpa o número e audita; o `unsubscribe` é melhor esforço. */
  async disconnect(actor: MembershipIdentity): Promise<void> {
    this.requirePermission(actor, 'channel:manage');
    const outcome = await this.deps.unitOfWork.run(async (tx) => {
      await tx.lockCompany(actor.companyId);
      const company = await tx.companies.findById(actor.companyId);
      const connection = await tx.connections.find(actor.companyId);
      // Nada a desconectar (segundo DELETE): sem mudança e sem evento.
      if (connection === null && company.whatsappPhoneNumberId === null) {
        return { changed: false as const };
      }
      if (connection !== null) await tx.connections.removeByCompany(actor.companyId);
      if (company.whatsappPhoneNumberId !== null) {
        await tx.companies.update(actor.companyId, { whatsappPhoneNumberId: null });
      }
      await tx.audit.create(actor.companyId, {
        action: 'CHANNEL_DISCONNECTED',
        actorMembershipId: actor.membershipId,
      });
      return {
        changed: true as const,
        old:
          connection === null
            ? undefined
            : { wabaId: connection.wabaId, ciphertext: connection.tokenCiphertext },
      };
    });
    if (!outcome.changed) return;
    this.afterCommit(actor, [{ action: 'CHANNEL_DISCONNECTED' }]);
    this.count('disconnect', 'ok');
    if (outcome.old !== undefined) await this.unsubscribe(actor.companyId, outcome.old);
  }

  // --- internos ---

  private requirePermission(actor: MembershipIdentity, permission: Permission): void {
    if (hasPermission(actor.role, permission)) return;
    this.deps.logger.warn(
      { actorMembershipId: actor.membershipId, role: actor.role, permission },
      'operação do canal negada pela permissão',
    );
    throw new ForbiddenError();
  }

  /**
   * Prova de posse com o token da empresa, antes de gravar qualquer coisa. Devolve a validade
   * informada pela Meta (`null` = não expira).
   */
  private async proveOwnership(token: SecretString, input: ChannelTarget): Promise<Date | null> {
    const inspected = await this.deps.provisioner.inspectToken(token);
    if (!inspected.ok) throw this.providerFailure(inspected.error);
    const inspection = inspected.value;
    if (!inspection.isValid) throw channelError('CHANNEL_TOKEN_REJECTED');
    if (inspection.appId !== this.deps.appId) throw channelError('CHANNEL_WRONG_APP');
    if (!REQUIRED_SCOPES.every((scope) => inspection.scopes.includes(scope))) {
      throw channelError('CHANNEL_MISSING_SCOPE');
    }
    if (
      inspection.wabaTargetIds !== undefined &&
      !inspection.wabaTargetIds.includes(input.wabaId)
    ) {
      throw channelError('CHANNEL_NUMBER_NOT_IN_WABA');
    }

    const numbers = await this.deps.provisioner.listPhoneNumberIds(input.wabaId, token);
    if (!numbers.ok) throw this.providerFailure(numbers.error);
    if (!numbers.value.includes(input.phoneNumberId)) {
      throw channelError('CHANNEL_NUMBER_NOT_IN_WABA');
    }

    const subscribed = await this.deps.provisioner.subscribeApp(input.wabaId, token);
    if (!subscribed.ok) throw this.providerFailure(subscribed.error);
    return inspection.expiresAt;
  }

  /** Cifra e grava, numa transação com a empresa travado: conexão, número e auditoria juntos. */
  private async persist(
    actor: MembershipIdentity,
    input: ChannelTarget,
    token: SecretString,
    expiresAt: Date | null,
    pinCiphertext?: string,
  ): Promise<{ readonly audit: AuditAction; readonly view: ChannelStateView }> {
    const ciphertext = this.deps.cipher.encrypt(actor.companyId, token);
    try {
      return await this.deps.unitOfWork.run(async (tx) => {
        await tx.lockCompany(actor.companyId);
        const saved = await tx.connections.save(actor.companyId, {
          wabaId: input.wabaId,
          tokenCiphertext: ciphertext,
          tokenExpiresAt: expiresAt,
          ...(pinCiphertext === undefined ? {} : { registrationPinCiphertext: pinCiphertext }),
        });
        const company = await tx.companies.update(actor.companyId, {
          whatsappPhoneNumberId: input.phoneNumberId,
        });
        const audit: AuditAction = saved.replaced ? 'CHANNEL_TOKEN_REPLACED' : 'CHANNEL_CONNECTED';
        await tx.audit.create(actor.companyId, {
          action: audit,
          actorMembershipId: actor.membershipId,
        });
        return { audit, view: toView(company, saved.connection) };
      });
    } catch (error) {
      // O `@unique` de `whatsappPhoneNumberId` decide a corrida; a transação inteira foi desfeita.
      if (error instanceof ConflictError) throw channelConflict();
      throw error;
    }
  }

  /** Erro da Meta vira 400 com código fixo (token ou posse) ou 502 genérico; nunca o corpo da Meta. */
  private providerFailure(error: ChannelProvisionError): Error {
    this.deps.logger.warn(
      {
        operation: error.operation,
        reason: error.reason,
        retryable: error.retryable,
        httpStatus: error.httpStatus,
        providerCode: error.providerCode,
      },
      'consulta ao provedor do canal falhou',
    );
    const unavailable = (): ExternalServiceError =>
      new ExternalServiceError('Provedor do canal indisponível', {
        context: { operation: error.operation },
      });
    if (error.operation === 'inspect_token') return unavailable();
    if (error.retryable || error.reason !== 'http_error') return unavailable();
    // `code` inválido, expirado, usado ou de outro app: uma só mensagem, sem distinguir.
    if (error.operation === 'exchange_code') return channelError('CHANNEL_CODE_INVALID');
    // PIN recusado (número já registrado com 2FA e outro PIN), número bloqueado etc.: mensagem fixa.
    if (error.operation === 'register') return channelError('CHANNEL_REGISTRATION_FAILED');
    if (error.providerCode === 190 || error.httpStatus === 401) {
      return channelError('CHANNEL_TOKEN_REJECTED');
    }
    return channelError(
      error.operation === 'list_numbers' ? 'CHANNEL_NUMBER_NOT_IN_WABA' : 'CHANNEL_MISSING_SCOPE',
    );
  }

  private async unsubscribe(
    companyId: CompanyId,
    old: { readonly wabaId: string; readonly ciphertext: string },
  ): Promise<void> {
    try {
      const token = this.deps.cipher.decrypt(companyId, old.ciphertext);
      const result = await this.deps.provisioner.unsubscribeApp(old.wabaId, token);
      if (result.ok) return;
      this.deps.logger.warn(
        { companyId, operation: result.error.operation, httpStatus: result.error.httpStatus },
        'não foi possível desassinar o app da WABA depois de desconectar',
      );
    } catch {
      this.deps.logger.warn(
        { companyId },
        'não foi possível desassinar o app da WABA depois de desconectar',
      );
    }
    this.count('disconnect', 'unsubscribe_failed');
  }

  private afterCommit(actor: MembershipIdentity, events: readonly PendingAudit[]): void {
    for (const event of events) {
      this.deps.logger.info(
        {
          event: 'audit',
          action: event.action,
          companyId: actor.companyId,
          actorMembershipId: actor.membershipId,
        },
        'audit',
      );
    }
  }

  private count(
    action: 'connect' | 'replace_token' | 'embedded_signup' | 'disconnect',
    result: MetricResult | 'unsubscribe_failed',
  ): void {
    try {
      this.deps.metrics?.countChannelConnection(action, result);
    } catch {
      // Métrica é acessório.
    }
  }
}

function channelError(code: ChannelErrorCode): ValidationError {
  return new ValidationError(CHANNEL_ERRORS[code], { code });
}

function channelConflict(): ConflictError {
  return new ConflictError(CHANNEL_ERRORS.CHANNEL_NUMBER_IN_USE, {
    code: 'CHANNEL_NUMBER_IN_USE',
  });
}

function resultOf(error: unknown): MetricResult {
  if (error instanceof ValidationError && error.code in RESULT_BY_CODE) {
    return RESULT_BY_CODE[error.code as ChannelErrorCode];
  }
  if (error instanceof ConflictError && error.code === 'CHANNEL_NUMBER_IN_USE') {
    return 'number_in_use';
  }
  return 'graph_error';
}
