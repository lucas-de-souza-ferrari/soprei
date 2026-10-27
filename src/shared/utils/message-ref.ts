import { createHash } from 'node:crypto';

/**
 * Referência curta e estável de um id de mensagem do canal, para correlacionar linhas de log sem
 * registrar o id. O `wamid` do WhatsApp carrega, codificado em base64, o número do contato:
 * logá-lo cru vazaria o telefone (dado pessoal). Os 16 primeiros caracteres hexadecimais do
 * SHA-256 bastam para correlacionar e não permitem recuperar o id.
 */
export function messageRef(channelMessageId: string): string {
  return createHash('sha256').update(channelMessageId).digest('hex').slice(0, 16);
}
