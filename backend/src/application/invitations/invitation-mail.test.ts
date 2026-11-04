import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INVITATION_MAIL_SUBJECT,
  invitationMailText,
  sanitizeCompanyName,
} from './invitation-mail.js';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BEL = String.fromCharCode(7);

describe('texto do e-mail de convite (spec 025, decisão 17)', () => {
  it('o assunto é fixo e não leva nome de empresa, papel nem código', () => {
    assert.equal(INVITATION_MAIL_SUBJECT, 'Você recebeu um convite para o Soprei');
  });

  it('o corpo tem as linhas combinadas, o nome entre aspas, o papel em português e o link em linha própria', () => {
    const lines = invitationMailText({
      companyName: 'Padaria Boa',
      role: 'AGENT',
      link: 'https://app.exemplo.test/convite#t=abc',
      validDays: 7,
    }).split(NL);
    assert.deepEqual(lines, [
      'Você foi convidado para participar da empresa "Padaria Boa" no Soprei, com o papel de Atendente.',
      '',
      'Para aceitar, abra o link abaixo. Ele vale por 7 dias e só pode ser usado uma vez:',
      '',
      'https://app.exemplo.test/convite#t=abc',
      '',
      'Se você não esperava este convite, ignore esta mensagem: nada acontece sem o seu aceite. Não compartilhe este link.',
    ]);
  });

  it('cada papel tem o seu rótulo', () => {
    const label = (role: 'ADMIN' | 'AGENT' | 'VIEWER'): string =>
      invitationMailText({ companyName: 'X', role, link: 'l', validDays: 7 });
    assert.match(label('ADMIN'), /papel de Administrador\./);
    assert.match(label('AGENT'), /papel de Atendente\./);
    assert.match(label('VIEWER'), /papel de Somente leitura\./);
  });

  it('sanitiza o nome: remove controle e quebras de linha, colapsa espaços e troca aspas duplas', () => {
    assert.equal(
      sanitizeCompanyName(`Banco${CR}${NL}Falso   X${BEL}  "Oficial"`),
      "Banco Falso X 'Oficial'",
    );
    // Nenhuma quebra de linha sobrevive: o nome não injeta linhas no texto fixo.
    const text = invitationMailText({
      companyName: `Linha 1${NL}${NL}Clique aqui: https://mal.test`,
      role: 'VIEWER',
      link: 'l',
      validDays: 7,
    });
    assert.equal(text.split(NL).length, 7);
  });

  it('limita o nome a 80 caracteres sem partir um emoji composto ao meio', () => {
    const long = 'a'.repeat(200);
    assert.equal(sanitizeCompanyName(long).length, 80);
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const cut = sanitizeCompanyName(`${'b'.repeat(79)}${family}${family}`);
    assert.ok(cut.startsWith('b'.repeat(79)));
    // O primeiro grafema (que inclui o ZWJ removido ou não) cabe inteiro ou não entra.
    assert.ok(!cut.endsWith(String.fromCharCode(0x200d)));
  });
});
