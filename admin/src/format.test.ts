import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ApiError } from './api';
import {
  accountActionErrorMessage,
  companyActionErrorMessage,
  errorMessage,
  formatCents,
  formatCount,
  formatDate,
  formatDateTime,
  formatUsage,
  label,
  loginErrorMessage,
  normalizeCode,
  signOutErrorMessage,
} from './format';

/** O Intl usa espaço fino/rígido em alguns formatos; os testes comparam com espaço comum. */
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('formatação do admin (spec 044, E3)', () => {
  it('números e valores em pt-BR', () => {
    assert.equal(formatCount(1234567), '1.234.567');
    assert.equal(formatCount(0), '0');
    assert.equal(plain(formatCents(59_600)), 'R$ 596,00');
    assert.equal(plain(formatCents(5)), 'R$ 0,05');
  });

  it('datas no fuso de São Paulo, e "—" quando não há', () => {
    assert.equal(formatDateTime('2026-11-24T12:30:00.000Z'), '24/11/2026, 09:30');
    assert.equal(formatDate('2026-12-01T02:59:00.000Z'), '30/11/2026');
    assert.equal(formatDateTime(null), '—');
    assert.equal(formatDate(null), '—');
  });

  it('uso contra a cota, com e sem limite', () => {
    assert.equal(formatUsage(1250, 5000), '1.250 de 5.000 (25%)');
    assert.equal(formatUsage(10, 0), '10 de 0 (100%)');
    assert.equal(formatUsage(7, null), '7 (sem limite)');
  });

  it('rótulos conhecidos em português; código desconhecido aparece como veio', () => {
    assert.equal(label('SUSPENDED'), 'Suspensa');
    assert.equal(label('OWNER_REQUEST'), 'Pedido do titular');
    assert.equal(label('NOVO_ESTADO'), 'NOVO_ESTADO');
  });

  it('mensagens de erro só por status e código, nunca pelo texto do servidor', () => {
    assert.equal(
      errorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE')),
      'Serviço indisponível no momento. Tente novamente em instantes.',
    );
    assert.equal(errorMessage(new ApiError(404)), 'Não encontrado.');
    assert.equal(
      errorMessage(new ApiError(0, 'NETWORK')),
      'Sem conexão com o servidor. Tente novamente.',
    );
    assert.equal(
      errorMessage(new ApiError(0, 'INVALID_RESPONSE')),
      'O servidor deu uma resposta inesperada.',
    );
    assert.equal(errorMessage(new Error('texto do servidor')), 'Algo deu errado. Tente novamente.');
    assert.equal(
      loginErrorMessage(new ApiError(401, 'UNAUTHORIZED')),
      'E-mail, senha ou código incorretos.',
    );
    assert.equal(
      loginErrorMessage(new ApiError(429, 'RATE_LIMITED')),
      'Muitas tentativas. Aguarde antes de tentar novamente.',
    );
    assert.equal(
      loginErrorMessage(new ApiError(403, 'FORBIDDEN')),
      'Este endereço não está autorizado a entrar.',
    );
    assert.equal(
      signOutErrorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE')),
      'Não foi possível sair: Serviço indisponível no momento. Tente novamente em instantes. Se persistir, feche o navegador.',
    );
  });

  it('código do autenticador: só dígitos, no máximo 6', () => {
    assert.equal(normalizeCode('123 456'), '123456');
    assert.equal(normalizeCode('12a3-4'), '1234');
    assert.equal(normalizeCode('12345678'), '123456');
  });

  it('ações da conta (spec 045, E2): códigos de regra explicados; o resto como qualquer erro', () => {
    assert.match(
      accountActionErrorMessage(new ApiError(400, 'CONFIRMATION_INVALID')),
      /^Código do autenticador inválido ou já usado/,
    );
    assert.match(accountActionErrorMessage(new ApiError(409, 'LAST_OWNER')), /única dona ativa/);
    assert.equal(
      accountActionErrorMessage(new ApiError(409, 'ALREADY_VERIFIED')),
      'O e-mail desta conta já está confirmado.',
    );
    assert.equal(
      accountActionErrorMessage(new ApiError(429, 'RATE_LIMITED')),
      'Muitas tentativas. Aguarde antes de tentar novamente.',
    );
    assert.equal(accountActionErrorMessage(new Error('x')), 'Algo deu errado. Tente novamente.');
    // 503 em desativar e encerrar sessões: a mudança pode ter sido gravada sem a revogação.
    for (const action of ['disable', 'revokeSessions'])
      assert.match(
        accountActionErrorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE'), action),
        /registrada sem que as sessões tenham sido encerradas: repita para concluir/,
      );
    assert.equal(
      accountActionErrorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE'), 'passwordReset'),
      'Serviço indisponível no momento. Tente novamente em instantes.',
    );
  });

  it('ações de empresa e vínculos (spec 045, E3a): códigos de regra explicados; 503 de papel e desativar', () => {
    assert.match(
      companyActionErrorMessage(new ApiError(400, 'CONFIRMATION_MISMATCH')),
      /slug digitado não confere/,
    );
    assert.match(
      companyActionErrorMessage(new ApiError(400, 'CONFIRMATION_INVALID')),
      /^Código do autenticador inválido ou já usado/,
    );
    assert.match(companyActionErrorMessage(new ApiError(409, 'LAST_OWNER')), /sem dono ativo/);
    assert.match(
      companyActionErrorMessage(new ApiError(409, 'MEMBER_NOT_ELIGIBLE')),
      /precisam estar ativos/,
    );
    for (const action of ['role', 'disable'])
      assert.match(
        companyActionErrorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE'), action),
        /registrada sem que as sessões tenham sido encerradas/,
      );
    assert.equal(
      companyActionErrorMessage(new ApiError(503, 'SERVICE_UNAVAILABLE'), 'rename'),
      'Serviço indisponível no momento. Tente novamente em instantes.',
    );
    assert.equal(companyActionErrorMessage(new ApiError(404, 'NOT_FOUND')), 'Não encontrado.');
  });

  it('ações da assinatura (spec 045, E4): códigos de regra com mensagem própria', () => {
    for (const [code, text] of [
      ['BILLING_DISABLED', /cobrança está desligada/],
      ['NO_SUBSCRIPTION', /não tem assinatura/],
      ['SUBSCRIPTION_EXISTS', /já tem assinatura/],
      ['ORDER_PENDING', /pagamento pendente/],
      ['PLAN_DOWNGRADE_BLOCKED', /não comporta as empresas/],
      ['PLAN_CHANGE_UNAVAILABLE', /paga e em vigor/],
      ['PLAN_UNAVAILABLE', /catálogo vigente/],
    ] as const)
      assert.match(companyActionErrorMessage(new ApiError(409, code)), text, code);
  });
});
