import { areaPageForPath, areaPath, type AreaPage } from './company/company-nav';

/** Páginas do site de contas e seus caminhos (spec 021 acrescenta recuperação de senha). */
export type AccountPage =
  'login' | 'register' | 'verify' | 'forgot' | 'reset' | 'invite' | 'companies' | AreaPage;

const PATHS: Record<AccountPage, string> = {
  login: '/entrar',
  register: '/criar-conta',
  verify: '/confirmar-email',
  forgot: '/recuperar-senha',
  reset: '/redefinir-senha',
  // Convite por e-mail (spec 025): o token vai no fragmento `#t=` e nunca no caminho.
  invite: '/convite',
  companies: '/painel/empresas',
  conversas: areaPath('conversas'),
  canal: areaPath('canal'),
  persona: areaPath('persona'),
  equipe: areaPath('equipe'),
  testar: areaPath('testar'),
};

/** Caminhos que o `main.tsx` entrega ao `AccountApp` (além de tudo sob `/painel`). */
export const ACCOUNT_PATHS: readonly string[] = [
  PATHS.login,
  PATHS.register,
  PATHS.verify,
  PATHS.forgot,
  PATHS.reset,
  PATHS.invite,
];

export function pathForPage(page: AccountPage): string {
  return PATHS[page];
}

/** Página inicial por caminho; qualquer outro valor abre a entrada (o painel é decidido pela sessão). */
export function pageForPath(pathname: string): AccountPage {
  switch (pathname) {
    case PATHS.register:
      return 'register';
    case PATHS.verify:
      return 'verify';
    case PATHS.forgot:
      return 'forgot';
    case PATHS.reset:
      return 'reset';
    case PATHS.invite:
      return 'invite';
    default:
      // As telas da empresa (spec 023) só abrem com sessão: o AccountApp decide depois de ler a sessão.
      return areaPageForPath(pathname) ?? 'login';
  }
}

/**
 * Política de senha do cadastro público (spec 017), a mesma da recuperação (spec 021): de 6 a 128
 * caracteres depois do NFKC, com uma maiúscula Unicode e um dígito, sem NUL.
 */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_HINT = 'Mínimo de 6 caracteres, com uma letra maiúscula e um número.';
export const PASSWORD_PROBLEM =
  'Use pelo menos 6 caracteres, incluindo uma letra maiúscula e um número.';

/** Texto do problema da senha nova, ou `null` se ela é aceita pelo servidor (mesma regra). */
export function passwordProblem(password: string): string | null {
  const normalized = password.normalize('NFKC');
  if (
    normalized.length < PASSWORD_MIN_LENGTH ||
    normalized.length > PASSWORD_MAX_LENGTH ||
    !/\p{Lu}/u.test(normalized) ||
    !/[0-9]/.test(normalized) ||
    normalized.includes(String.fromCharCode(0))
  ) {
    return PASSWORD_PROBLEM;
  }
  return null;
}

/** Resposta neutra do pedido de código: igual para conta existente ou não. */
export const RESET_NEUTRAL_MESSAGE =
  'Se existir uma conta, enviamos um código para o e-mail informado.';
export const RESET_INVALID_CODE_MESSAGE =
  'Código inválido ou expirado. Se errou várias vezes, peça um novo código.';
export const RESET_SUCCESS_MESSAGE = 'Senha redefinida. Entre com a nova senha.';

/**
 * Erro do pedido de código que vira a mensagem neutra: qualquer 4xx menos o 429 (o limite de
 * tentativas é informado de verdade). Erro de servidor e de rede seguem como falha.
 */
export function isNeutralResetRequestError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}
