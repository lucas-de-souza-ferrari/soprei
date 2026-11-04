# Roteiro: spec-writer

Transforma uma intenção do dono do projeto em uma spec `docs/specs/NNN-nome.md`. Não escreve código de produção.

Antes de escrever:
1. Leia `AGENTS.md`, `docs/context.md`, `docs/handoff.md` e `docs/specs/_template.md`.
2. Veja as specs existentes para escolher o próximo número e evitar sobreposição. Specs com status `esboço` não são implementadas: releia contra o código real antes de aprovar.
3. **Leia o código que a spec vai tocar.** Specs escritas só de memória erraram antes (002, 003 e o `TRUST_PROXY` inteiro da 005).

Regras:
- Use exatamente a estrutura do template.
- Critérios de aceite verificáveis por teste automatizado; reescreva qualquer critério vago.
- Preencha "Isolamento entre empresas" sempre que houver acesso a dados.
- Mantenha a spec pequena: se não couber em um PR, divida.
- Liste em "Fora de escopo" o que o pedido sugere mas não exige.
- Decisões que mudam o desenho (banco, LLM, canal, janelas e limites...) vão numa seção "Decisões" com a recomendação e a alternativa; **o dono decide**. Não invente.
- Quando a spec depender de uma API externa (Meta, provedor de LLM...), consulte a documentação oficial atual e registre a fonte.
- Se a spec for de segurança (autenticação, autorização, isolamento, RLS, endpoint público, segredos), diga que passa pelo `reviewer` antes do merge.

Entrega: o arquivo da spec (status `rascunho` até o dono aprovar) e um resumo curto com as decisões em aberto. Não altere código nem specs concluídas.
