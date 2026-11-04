import { z } from 'zod';

/**
 * Jornada de convite por e-mail (spec 025). O link do e-mail é `/convite#t=<token>`: o token vai no
 * **fragmento**, que o navegador não envia ao servidor nem em `Referer`. A página o lê uma vez, o tira da
 * barra de endereço e o mantém **só em memória** (nada em `localStorage`, `sessionStorage`, título nem URL).
 */
export const INVITE_TOKEN_MAX_LENGTH = 256;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<companyId>.<invitationId>.<segredo de 43 caracteres base64url>`: o formato exato do servidor. */
const TOKEN_PATTERN = new RegExp(`^${UUID}\\.${UUID}\\.[A-Za-z0-9_-]{43}$`, 'i');

/**
 * O token de um fragmento `#t=<token>`, ou `null` se o fragmento está ausente, vazio, longo demais,
 * traz outros parâmetros ou o token não tem o formato esperado (a tela de falha abre sem chamar a API).
 */
export function parseInviteHash(hash: string): string | null {
  if (!hash.startsWith('#t=')) return null;
  const token = hash.slice(3);
  if (token.length === 0 || token.length > INVITE_TOKEN_MAX_LENGTH) return null;
  return TOKEN_PATTERN.test(token) ? token : null;
}

/** Lê o fragmento da barra de endereço e a **limpa** (`replaceState`), mesmo quando o token é inválido. */
export function takeInviteToken(): string | null {
  const token = parseInviteHash(location.hash);
  history.replaceState(null, '', location.pathname);
  return token;
}

export const INVITE_FAILURE_MESSAGE =
  'Este convite é inválido, venceu ou foi enviado para outro e-mail.';
export const INVITE_UNAVAILABLE_MESSAGE =
  'Não foi possível verificar o convite agora. Tente de novo em instantes.';
export const INVITE_ACCOUNT_CREATED_MESSAGE = 'Conta criada. Entre com a senha que você definiu.';
export const INVITE_RATE_MESSAGE = 'Muitas tentativas. Aguarde antes de tentar novamente.';

export const INVITE_ROLE_LABELS = {
  ADMIN: 'Administrador',
  AGENT: 'Atendente',
  VIEWER: 'Somente leitura',
} as const;

export const invitePreviewSchema = z.strictObject({
  companyName: z.string().min(1).max(200),
  role: z.enum(['ADMIN', 'AGENT', 'VIEWER']),
  email: z.string().min(1).max(254),
  accountState: z.enum(['NEW', 'EXISTS']),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

/**
 * Mensagem de uma falha de `preview`/`accept`/`accept-new`, só por `status` e `error.code`. O 400
 * `INVITATION_INVALID` (qualquer problema do convite) e o 400 sem código dão a mesma mensagem única;
 * erro de servidor ou de rede é "indisponível" e pode ser repetido.
 */
export function inviteFailureKind(
  status: number | undefined,
  code: string | undefined,
): 'invalid' | 'session' | 'rate' | 'unavailable' | 'policy' {
  if (status === 401) return 'session';
  if (status === 429) return 'rate';
  if (status === 400 && code === 'INVITATION_INVALID') return 'invalid';
  if (status === 400 && code === 'VALIDATION_ERROR') return 'policy';
  return 'unavailable';
}

/** O e-mail da sessão é o do convite (comparação sem diferenciar maiúsculas). */
export function sameEmail(a: string, b: string): boolean {
  return a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();
}
