import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Autenticação da webhook_url da InfinitePay (spec 031, E3): o webhook é público e sem assinatura, então a
 * URL leva um segredo derivado por pedido, calculado ao criar o link. token = HMAC-SHA256(chave derivada do
 * JWT_SECRET com rótulo próprio, orderId) em base64url. A conferência é em tempo constante. O token e o
 * orderId nunca vão a log.
 */
export function deriveWebhookSecret(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('soprei:infinitepay-webhook:v1').digest();
}

export function webhookToken(secret: Buffer, orderId: string): string {
  return createHmac('sha256', secret).update(orderId).digest('base64url');
}

/** Sempre calcula o HMAC e compara em tempo constante (token de tamanho errado é só falso). */
export function verifyWebhookToken(secret: Buffer, orderId: string, token: string): boolean {
  const expected = Buffer.from(webhookToken(secret, orderId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
