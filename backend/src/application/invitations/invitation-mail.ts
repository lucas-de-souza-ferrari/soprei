import type { CompanyInvitationMail } from '../ports/account-session.js';

/** Assunto fixo (spec 025, decisão 17): sem nome da empresa, sem papel, sem código. */
export const INVITATION_MAIL_SUBJECT = 'Você recebeu um convite para o Soprei';

const COMPANY_NAME_MAX = 80;
const SEGMENTER = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });

/** Caracteres de controle, separadores de linha e parágrafo e caracteres de formato (inclui controles de direção de texto). */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * O nome da empresa é texto livre de quem a criou: remove controle e quebras de linha, colapsa
 * espaços, troca aspas duplas (o texto já o põe entre aspas) e limita a 80 caracteres, para não
 * permitir injeção de linhas nem texto enganoso longo no e-mail.
 */
export function sanitizeCompanyName(name: string): string {
  const cleaned = name.replace(UNSAFE_CHARS, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  // Por grafema (não parte um emoji composto ao meio).
  const graphemes = Array.from(SEGMENTER.segment(cleaned), (part) => part.segment);
  return graphemes.slice(0, COMPANY_NAME_MAX).join('').trim();
}

const ROLE_LABELS: Readonly<Record<CompanyInvitationMail['role'], string>> = {
  ADMIN: 'Administrador',
  AGENT: 'Atendente',
  VIEWER: 'Somente leitura',
};

/** Corpo em texto simples (sem HTML). Não revela quem convidou nem dado de outra empresa. */
export function invitationMailText(mail: CompanyInvitationMail): string {
  return [
    `Você foi convidado para participar da empresa "${sanitizeCompanyName(mail.companyName)}" no Soprei, com o papel de ${ROLE_LABELS[mail.role]}.`,
    '',
    `Para aceitar, abra o link abaixo. Ele vale por ${String(mail.validDays)} dias e só pode ser usado uma vez:`,
    '',
    mail.link,
    '',
    'Se você não esperava este convite, ignore esta mensagem: nada acontece sem o seu aceite. Não compartilhe este link.',
  ].join('\n');
}
