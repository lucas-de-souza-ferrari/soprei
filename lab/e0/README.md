# Laboratório E0 da spec 039 (coexistência)

Ferramentas **temporárias** para o passo zero da [spec 039](../../docs/specs/039-conexao-por-coexistencia.md). Esta pasta vive só na branch `lab/e0-coexistencia` e **nunca vai para a `main`**.

- `coex.html`: página que abre o popup do Embedded Signup com `featureType: whatsapp_business_app_onboarding` e mostra o que a Meta devolve (só nomes de chaves e valores seguros; o `code` aparece numa caixa para ser copiado ao servidor).
- `lab.mjs`: `conectar` (troca o `code`, mostra conta e número, assina o app na WABA), `enviar` (mensagem de teste pela Cloud API) e `limpar` (desassina e apaga o estado com o token).
- `webhook-logger.mjs`: registrador que roda no lugar do Soprei por alguns minutos e anota só o formato dos webhooks (campo, chaves, tamanhos, referência dos ids), nunca o texto nem telefones.

Nada disso grava no banco do Soprei. Ao fim do teste: `node lab.mjs limpar`, apagar a página do site e `/root/soprei-lab*`.
