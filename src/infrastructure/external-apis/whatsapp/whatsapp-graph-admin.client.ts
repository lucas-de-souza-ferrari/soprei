import { z } from 'zod';
import {
  ChannelProvisionError,
  type ChannelProvisioner,
  type ProvisionOperation,
  type TokenInspection,
} from '../../../application/ports/channel-provisioner.js';
import { Result, type SecretString } from '../../../shared/types/index.js';
import {
  isRetryableGraphFailure,
  isTimeout,
  MAX_RESPONSE_BYTES,
  parseJson,
  readCapped,
} from './whatsapp-cloud-api.client.js';

/** Escopos do WhatsApp cujos `target_ids` (WABAs) interessam. */
const WHATSAPP_SCOPES: ReadonlySet<string> = new Set([
  'whatsapp_business_messaging',
  'whatsapp_business_management',
]);
/** Teto de páginas seguidas na lista de números (uma WABA tem poucos). */
const MAX_PAGES = 10;

const graphErrorSchema = z.object({ error: z.object({ code: z.number().int().optional() }) });

const debugTokenSchema = z.object({
  data: z.object({
    is_valid: z.boolean(),
    app_id: z.union([z.string(), z.number()]).optional(),
    scopes: z.array(z.string()).optional(),
    granular_scopes: z
      .array(
        z.object({
          scope: z.string(),
          target_ids: z.array(z.union([z.string(), z.number()])).optional(),
        }),
      )
      .optional(),
    expires_at: z.number().optional(),
  }),
});

const phoneNumbersSchema = z.object({
  data: z.array(z.object({ id: z.union([z.string(), z.number()]) })),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

const successSchema = z.object({ success: z.boolean() });

export interface WhatsappGraphAdminClientOptions {
  readonly baseUrl: string;
  readonly graphApiVersion: string;
  /** `WHATSAPP_APP_ID`. */
  readonly appId: string;
  /** `WHATSAPP_APP_SECRET`: só vai em cabeçalho (token de app), nunca em URL, log ou erro. */
  readonly appSecret: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

interface CallParams {
  readonly operation: ProvisionOperation;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  /** Valor de `Authorization: Bearer`. */
  readonly bearer: string;
  readonly query?: Readonly<Record<string, string>>;
}

/**
 * Cliente Graph de administração do canal (spec 015): `debug_token`, lista de números da WABA e
 * `subscribed_apps`. Mesmo padrão do `WhatsappCloudApiClient`: `fetch` nativo, `redirect: 'manual'`
 * (redirecionar levaria o token a outro host), prazo por `AbortSignal.timeout`, leitura com teto de
 * 64 KiB e schemas Zod tolerantes. O token do cliente e o token de app vão em `Authorization`; o
 * único valor sensível em URL é o `input_token` do `debug_token` (a API da Meta só o aceita assim),
 * e a URL nunca é logada. O erro devolvido nunca carrega o corpo da Meta.
 */
export class WhatsappGraphAdminClient implements ChannelProvisioner {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: WhatsappGraphAdminClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  async inspectToken(token: SecretString): Promise<Result<TokenInspection, ChannelProvisionError>> {
    const result = await this.call({
      operation: 'inspect_token',
      method: 'GET',
      path: 'debug_token',
      bearer: `${this.options.appId}|${this.options.appSecret}`,
      query: { input_token: token.reveal() },
    });
    if (!result.ok) return result;
    const parsed = debugTokenSchema.safeParse(result.value);
    if (!parsed.success) return invalid('inspect_token');
    const data = parsed.data.data;
    const targets = new Set<string>();
    let hasTargets = false;
    const scopes = new Set(data.scopes ?? []);
    for (const granular of data.granular_scopes ?? []) {
      scopes.add(granular.scope);
      if (WHATSAPP_SCOPES.has(granular.scope) && granular.target_ids !== undefined) {
        hasTargets = true;
        for (const id of granular.target_ids) targets.add(String(id));
      }
    }
    const expires = data.expires_at;
    return Result.ok({
      isValid: data.is_valid,
      appId: data.app_id === undefined ? undefined : String(data.app_id),
      scopes: [...scopes],
      wabaTargetIds: hasTargets ? [...targets] : undefined,
      expiresAt: expires === undefined || expires === 0 ? null : new Date(expires * 1000),
    });
  }

  async listPhoneNumberIds(
    wabaId: string,
    token: SecretString,
  ): Promise<Result<readonly string[], ChannelProvisionError>> {
    const ids: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.call({
        operation: 'list_numbers',
        method: 'GET',
        path: `${encodeURIComponent(wabaId)}/phone_numbers`,
        bearer: token.reveal(),
        query: { fields: 'id', limit: '100', ...(after === undefined ? {} : { after }) },
      });
      if (!result.ok) return result;
      const parsed = phoneNumbersSchema.safeParse(result.value);
      if (!parsed.success) return invalid('list_numbers');
      for (const item of parsed.data.data) ids.push(String(item.id));
      const next = parsed.data.paging?.next;
      after = parsed.data.paging?.cursors?.after;
      if (next === undefined || after === undefined) break;
    }
    return Result.ok(ids);
  }

  subscribeApp(wabaId: string, token: SecretString): Promise<Result<void, ChannelProvisionError>> {
    return this.subscription('subscribe', 'POST', wabaId, token);
  }

  unsubscribeApp(
    wabaId: string,
    token: SecretString,
  ): Promise<Result<void, ChannelProvisionError>> {
    return this.subscription('unsubscribe', 'DELETE', wabaId, token);
  }

  private async subscription(
    operation: 'subscribe' | 'unsubscribe',
    method: 'POST' | 'DELETE',
    wabaId: string,
    token: SecretString,
  ): Promise<Result<void, ChannelProvisionError>> {
    const result = await this.call({
      operation,
      method,
      path: `${encodeURIComponent(wabaId)}/subscribed_apps`,
      bearer: token.reveal(),
    });
    if (!result.ok) return result;
    const parsed = successSchema.safeParse(result.value);
    if (!parsed.success || !parsed.data.success) return invalid(operation);
    return Result.ok(undefined);
  }

  private async call(params: CallParams): Promise<Result<unknown, ChannelProvisionError>> {
    const query = new URLSearchParams(params.query).toString();
    const url = `${this.baseUrl}/${this.options.graphApiVersion}/${params.path}${query === '' ? '' : `?${query}`}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: params.method,
        headers: { authorization: `Bearer ${params.bearer}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return Result.err(
        new ChannelProvisionError({
          operation: params.operation,
          reason: isTimeout(error) ? 'timeout' : 'network',
          retryable: true,
        }),
      );
    }

    let raw: unknown;
    try {
      const read = await readCapped(response, MAX_RESPONSE_BYTES);
      raw = read.tooLarge ? undefined : parseJson(read.text);
      if (read.tooLarge && response.ok) return invalid(params.operation, response.status);
    } catch (error) {
      if (response.ok) {
        return Result.err(
          new ChannelProvisionError({
            operation: params.operation,
            reason: isTimeout(error) ? 'timeout' : 'invalid_response',
            retryable: false,
            httpStatus: response.status,
          }),
        );
      }
      raw = undefined;
    }

    if (response.ok) return Result.ok(raw);
    const graphError = graphErrorSchema.safeParse(raw);
    const providerCode = graphError.success ? graphError.data.error.code : undefined;
    return Result.err(
      new ChannelProvisionError({
        operation: params.operation,
        reason: 'http_error',
        retryable: isRetryableGraphFailure(response.status, providerCode),
        httpStatus: response.status,
        ...(providerCode === undefined ? {} : { providerCode }),
      }),
    );
  }
}

function invalid(
  operation: ProvisionOperation,
  httpStatus?: number,
): Result<never, ChannelProvisionError> {
  return Result.err(
    new ChannelProvisionError({
      operation,
      reason: 'invalid_response',
      retryable: false,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  );
}
