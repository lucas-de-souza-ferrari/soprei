import { createHmac } from 'node:crypto';

/** `X-Hub-Signature-256` de um corpo: `sha256=` + HMAC-SHA256 hexadecimal com o segredo do app. */
export function signWebhookBody(body: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

/** `wamid` de mentira que, como o real, carrega o telefone do contato em base64. */
export function fakeWamid(contact: string, suffix = ''): string {
  return `wamid.${Buffer.from(`\u001c\u0018\u000b${contact}`).toString('base64')}${suffix}`;
}

export interface FakeInboundMessage {
  readonly id: string;
  readonly from?: string;
  readonly type?: string;
  readonly text?: string;
  /** Campos extras no objeto da mensagem (ex.: `from_user_id`, `image`). */
  readonly extra?: Record<string, unknown>;
}

export interface FakeStatus {
  readonly id: string;
  readonly status: string;
  readonly recipientId?: string;
  readonly errorCode?: number;
}

export interface FakeChange {
  readonly phoneNumberId: string;
  readonly messages?: readonly FakeInboundMessage[];
  readonly statuses?: readonly FakeStatus[];
  /** Nome de perfil do contato, só para provar que ele nunca é lido nem logado. */
  readonly profileName?: string;
}

/** Payload no formato da documentação da Meta (campo `messages`), com `changes` e `entry` extras. */
export function webhookPayload(changes: readonly FakeChange[]): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: changes.map((change) => ({
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '15550783881',
              phone_number_id: change.phoneNumberId,
            },
            ...(change.profileName === undefined
              ? {}
              : { contacts: [{ profile: { name: change.profileName }, wa_id: '16505551234' }] }),
            ...(change.messages === undefined
              ? {}
              : {
                  messages: change.messages.map((message) => ({
                    ...(message.from === undefined ? {} : { from: message.from }),
                    id: message.id,
                    timestamp: '1749416383',
                    type: message.type ?? 'text',
                    ...(message.text === undefined ? {} : { text: { body: message.text } }),
                    ...message.extra,
                  })),
                }),
            ...(change.statuses === undefined
              ? {}
              : {
                  statuses: change.statuses.map((status) => ({
                    id: status.id,
                    status: status.status,
                    timestamp: '1751142888',
                    ...(status.recipientId === undefined
                      ? {}
                      : { recipient_id: status.recipientId }),
                    ...(status.errorCode === undefined
                      ? {}
                      : {
                          errors: [
                            {
                              code: status.errorCode,
                              title: 'título da Meta',
                              message: 'mensagem da Meta com dado pessoal',
                              error_data: { details: 'detalhe da Meta' },
                            },
                          ],
                        }),
                  })),
                }),
          },
        })),
      },
    ],
  };
}

export interface FakeEcho {
  readonly id: string;
  /** O contato a quem a equipe escreveu. */
  readonly to?: string;
  readonly type?: string;
  readonly text?: string;
}

/**
 * Webhook de eco da coexistência (spec 039), no formato visto no E0: campo `smb_message_echoes` e a
 * lista em `value.message_echoes[]`; `from` é o número da empresa e `to` é o contato. Traz também os
 * campos novos de identificador de 19 caracteres, que o Soprei não lê.
 */
export function echoWebhookPayload(
  phoneNumberId: string,
  echoes: readonly FakeEcho[],
  field = 'smb_message_echoes',
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: echoes.map((echo) => ({ wa_id: echo.to, user_id: '1234567890123456789' })),
              message_echoes: echoes.map((echo) => ({
                from: '15550783881',
                ...(echo.to === undefined ? {} : { to: echo.to }),
                to_user_id: '1234567890123456789',
                id: echo.id,
                timestamp: '1762958100',
                type: echo.type ?? 'text',
                ...(echo.text === undefined ? {} : { text: { body: echo.text } }),
              })),
            },
          },
        ],
      },
    ],
  };
}
