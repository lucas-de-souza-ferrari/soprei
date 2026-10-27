# 008 — Autorização por papéis e permissões (RBAC)

- **Status:** esboço (sob demanda: reler contra o código antes de aprovar; gatilho: junto com a autenticação, com mais de um papel; exige revisão do `reviewer`)
- **Branch:** `spec/008-rbac`
- **Depende de:** 007

## Objetivo

Controlar o que cada usuário pode fazer dentro do seu cliente, com papéis e permissões declarados no código e verificados por hooks reutilizáveis.

## Comportamento esperado

- Enum de papéis em `src/domain/` (valores iniciais propostos: `OWNER`, `ADMIN`, `AGENT`, `VIEWER`) e enum/união de permissões por recurso e ação (ex.: `conversation:read`, `conversation:reply`, `user:manage`).
- Mapa estático `papel -> permissões` em `src/domain/`, versionado em código e coberto por teste. O token carrega só o papel; as permissões são derivadas no servidor, então mudar o mapa vale na hora sem reemitir tokens.
- Hooks do Fastify em `src/presentation/`:
  - `requirePermissions([...])`: exige **todas** as permissões listadas, senão 403;
  - `requireRoles([...])`: exige **ao menos um** dos papéis, senão 403;
  - ambos assumem `authenticate` anterior (401 se não houver identidade).
- Rotas administrativas da spec 003 (CRUD de `Client`) e de usuários (`User`) passam a exigir permissão adequada.
- CRUD de usuários do próprio cliente (criar, alterar papel, desativar) protegido por `user:manage`; impossível alterar papel de usuário de outro cliente; um usuário não pode elevar o próprio papel.
- Log de auditoria (estruturado, via Pino) para mudança de papel e desativação de usuário.

## Critérios de aceite

- [ ] Teste: cada papel recebe exatamente as permissões do mapa (snapshot do mapa).
- [ ] Teste: `requirePermissions` exige todas; falta uma = 403.
- [ ] Teste: `requireRoles` aceita qualquer um da lista; fora dela = 403.
- [ ] Teste: sem token, 401; com token válido mas sem permissão, 403.
- [ ] Teste: usuário não eleva o próprio papel; `ADMIN` não cria `OWNER` (ou regra equivalente definida nesta spec).
- [ ] Teste de isolamento: admin do cliente A não lista, altera nem desativa usuários do cliente B.
- [ ] Teste: mudança de papel gera log de auditoria com quem mudou, quem foi alterado e papéis antigo e novo.

## Casos de borda e erros

- Papel desconhecido em token antigo: tratado como sem permissões (403), nunca como erro 500.
- Último `OWNER` do cliente não pode ser removido nem rebaixado.

## Isolamento entre clientes

Papéis valem **dentro** do cliente. Não existe papel que atravesse clientes nesta spec.

## Fora de escopo

- Papel de super-admin da plataforma (cross-tenant): exige decisão e spec própria, por ser o ponto de maior risco de vazamento.
- Permissões por objeto individual (ABAC) e papéis customizáveis por cliente.

## Decisões e dependências novas

- Sem dependências novas.
- **Pergunta:** quais papéis e permissões iniciais o produto realmente precisa? A lista acima é uma proposta.
