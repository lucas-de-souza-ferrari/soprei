import type { PasswordResetMailer } from '../application/ports/account-session.js';

/** Parte da recuperação de senha do mailer para os testes que só exercitam a confirmação de e-mail. */
export const noResetMail: PasswordResetMailer = {
  sendPasswordReset: () => Promise.resolve(),
  sendPasswordChanged: () => Promise.resolve(),
};
