import { randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type AuditAction,
  type ChannelConnection,
  type ChannelConnectionRepository,
  type Client,
  type ClientId,
  type ClientRepository,
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
import type { UserIdentity } from '../auth/identity.js';
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
  CHANNEL_NUMBER_IN_USE: 'Este número já está conectado a outro cliente',
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
  readonly clients: Pick<ClientRepository, 'findById' | 'findByWhatsappPhoneNumberId'>;
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

function toView(client: Client, connection: ChannelConnection | null): ChannelStateView {
  const number = client.whatsappPhoneNumberId;
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
 * Conexão do canal WhatsApp do próprio cliente (spec 015): estado, conectar ou trocar o token
 * (`PUT`) e desconectar. O `ClientId` vem sempre do ator (token de acesso). Antes de gravar, prova a
 * posse do número com o **token do próprio cliente** (`debug_token` com `app_id` fixo, escopos, lista
 * de números da WABA e `subscribed_apps`); a gravação (cifra, conexão, número do cliente e
 * auditoria) é uma transação com o cliente travado. **Nunca** loga nem devolve token, texto cifrado,
 * número ou WABA: só ids internos e enums.
 */
export class ChannelConnectionService {
  constructor(private readonly deps: ChannelConnectionServiceDeps) {}

  async getState(actor: UserIdentity): Promise<ChannelStateView> {
    this.requirePermission(actor, 'channel:read');
    const [client, connection] = await Promise.all([
      this.deps.clients.findById(actor.clientId),
      this.deps.connections.find(actor.clientId),
    ]);
    return toView(client, connection);
  }

  /** Conecta ou troca o token (idempotente; também reconecta depois de `TOKEN_INVALID`). */
  async connect(actor: UserIdentity, input: ConnectChannelInput): Promise<ChannelStateView> {
    this.requirePermission(actor, 'channel:manage');
    const existing = await this.deps.connections.find(actor.clientId);
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
   * digitado pelo cliente) e grava tudo cifrado, com auditoria, na mesma transação do `PUT`. Se o
   * `/register` falhar, **nada é gravado** (o cliente refaz o fluxo, que gera outro `code`). O `code`,
   * o token e o PIN nunca vão a log, erro, métrica nem resposta.
   */
  async embeddedSignup(actor: UserIdentity, input: EmbeddedSignupInput): Promise<ChannelStateView> {
    this.requirePermission(actor, 'channel:manage');
    try {
      const exchanged = await this.deps.provisioner.exchangeCode(new SecretString(input.code));
      if (!exchanged.ok) throw this.providerFailure(exchanged.error);
      const token = exchanged.value;
      const expiresAt = await this.proveOwnership(token, input);
      // Número de OUTRO cliente: 409 antes de registrar. Sem isto, um token que enxerga a WABA
      // compartilhada trocaria o PIN do número alheio pelo `/register`. (A corrida entre dois
      // clientes ainda é decidida pelo `@unique`, na transação.)
      const owner = await this.deps.clients.findByWhatsappPhoneNumberId(input.phoneNumberId);
      if (owner !== null && owner.id !== actor.clientId) throw channelConflict();
      const pin = await this.registrationPin(actor.clientId);
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
        this.deps.cipher.encrypt(actor.clientId, pin),
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
   * PIN do registro: o que já está guardado para este cliente (o número já foi registrado com ele e
   * registrar de novo com o mesmo PIN é aceito), senão um novo, aleatório. PIN guardado que não
   * decifra é ignorado, com `warn` só com o `clientId` (gera outro).
   */
  private async registrationPin(clientId: ClientId): Promise<SecretString> {
    const existing = await this.deps.connections.find(clientId);
    if (existing?.registrationPinCiphertext != null) {
      try {
        return this.deps.cipher.decrypt(clientId, existing.registrationPinCiphertext);
      } catch {
        // Falha ao decifrar (chave removida, texto adulterado): segue com um PIN novo, mas avisa. O
        // log leva só o `clientId`: nada do PIN, do texto cifrado nem do erro.
        this.deps.logger.warn(
          { clientId },
          'PIN de registro guardado não pôde ser decifrado; gerando um PIN novo',
        );
      }
    }
    const generate = this.deps.generatePin ?? (() => randomInt(0, 1_000_000).toString());
    return new SecretString(generate().padStart(6, '0'));
  }

  /** Desconecta (idempotente): apaga a conexão, limpa o número e audita; o `unsubscribe` é melhor esforço. */
  async disconnect(actor: UserIdentity): Promise<void> {
    this.requirePermission(actor, 'channel:manage');
    const outcome = await this.deps.unitOfWork.run(async (tx) => {
      await tx.lockClient(actor.clientId);
      const client = await tx.clients.findById(actor.clientId);
      const connection = await tx.connections.find(actor.clientId);
      // Nada a desconectar (segundo DELETE): sem mudança e sem evento.
      if (connection === null && client.whatsappPhoneNumberId === null) {
        return { changed: false as const };
      }
      if (connection !== null) await tx.connections.removeByClient(actor.clientId);
      if (client.whatsappPhoneNumberId !== null) {
        await tx.clients.update(actor.clientId, { whatsappPhoneNumberId: null });
      }
      await tx.audit.create(actor.clientId, {
        action: 'CHANNEL_DISCONNECTED',
        actorUserId: actor.userId,
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
    if (outcome.old !== undefined) await this.unsubscribe(actor.clientId, outcome.old);
  }

  // --- internos ---

  private requirePermission(actor: UserIdentity, permission: Permission): void {
    if (hasPermission(actor.role, permission)) return;
    this.deps.logger.warn(
      { actorUserId: actor.userId, role: actor.role, permission },
      'operação do canal negada pela permissão',
    );
    throw new ForbiddenError();
  }

  /**
   * Prova de posse com o token do cliente, antes de gravar qualquer coisa. Devolve a validade
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

  /** Cifra e grava, numa transação com o cliente travado: conexão, número e auditoria juntos. */
  private async persist(
    actor: UserIdentity,
    input: ChannelTarget,
    token: SecretString,
    expiresAt: Date | null,
    pinCiphertext?: string,
  ): Promise<{ readonly audit: AuditAction; readonly view: ChannelStateView }> {
    const ciphertext = this.deps.cipher.encrypt(actor.clientId, token);
    try {
      return await this.deps.unitOfWork.run(async (tx) => {
        await tx.lockClient(actor.clientId);
        const saved = await tx.connections.save(actor.clientId, {
          wabaId: input.wabaId,
          tokenCiphertext: ciphertext,
          tokenExpiresAt: expiresAt,
          ...(pinCiphertext === undefined ? {} : { registrationPinCiphertext: pinCiphertext }),
        });
        const client = await tx.clients.update(actor.clientId, {
          whatsappPhoneNumberId: input.phoneNumberId,
        });
        const audit: AuditAction = saved.replaced ? 'CHANNEL_TOKEN_REPLACED' : 'CHANNEL_CONNECTED';
        await tx.audit.create(actor.clientId, { action: audit, actorUserId: actor.userId });
        return { audit, view: toView(client, saved.connection) };
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
    clientId: ClientId,
    old: { readonly wabaId: string; readonly ciphertext: string },
  ): Promise<void> {
    try {
      const token = this.deps.cipher.decrypt(clientId, old.ciphertext);
      const result = await this.deps.provisioner.unsubscribeApp(old.wabaId, token);
      if (result.ok) return;
      this.deps.logger.warn(
        { clientId, operation: result.error.operation, httpStatus: result.error.httpStatus },
        'não foi possível desassinar o app da WABA depois de desconectar',
      );
    } catch {
      this.deps.logger.warn(
        { clientId },
        'não foi possível desassinar o app da WABA depois de desconectar',
      );
    }
    this.count('disconnect', 'unsubscribe_failed');
  }

  private afterCommit(actor: UserIdentity, events: readonly PendingAudit[]): void {
    for (const event of events) {
      this.deps.logger.info(
        {
          event: 'audit',
          action: event.action,
          clientId: actor.clientId,
          actorUserId: actor.userId,
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
