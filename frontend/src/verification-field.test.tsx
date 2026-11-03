import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerificationField } from './verification-field';

const render = (props: { value?: string; error?: string } = {}) =>
  renderToStaticMarkup(
    <VerificationField value={props.value ?? ''} onChange={() => undefined} error={props.error} />,
  );

test('campo do código: teclado numérico, código de uso único e rótulo preservado', () => {
  const html = render();
  assert.match(html, /inputmode="numeric"/i);
  assert.match(html, /autocomplete="one-time-code"/i);
  assert.match(html, /pattern="\[0-9\]\*"/);
  assert.match(html, /id="verification"/);
  assert.match(html, /Código recebido por e-mail/);
  // Folga para colar com separadores antes de normalizar (o navegador corta no maxLength).
  const max = /maxlength="(\d+)"/i.exec(html);
  assert.ok(max);
  assert.ok(Number(max[1]) >= 7);
});

test('campo do código: mostra o valor e a mensagem de erro local', () => {
  const html = render({ value: '123456', error: 'Digite os 6 dígitos do código' });
  assert.match(html, /value="123456"/);
  assert.match(html, /Digite os 6 dígitos do código/);
});
