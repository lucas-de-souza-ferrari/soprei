# 007 — Autenticação com JWT e refresh token

- **Status:** rascunho
- **Branch:** `spec/007-autenticacao-jwt`
- **Depende de:** 002, 003, 004, 005

## Objetivo

Usuários dos clientes (atendentes e administradores) fazem login, recebem access token curto e refresh token com rotação, e toda rota protegida sabe quem é o usuário e a qual cliente ele pertence.

## Comportamento esperado

- Modelo `User` escopado por tenant: id, `clientId` (obrigatório), email (único **por cliente**), `passwordHash`, `role` (enum, usada na spec 008), status, timestamps. Repositório via `TenantRepository`, exceto a busca de login, que é a única que localiza por email e identificação do cliente (slug) e fica isolada e testada.
- Hash de senha com **argon2id** (`argon2`). Política mínima de senha validada com Zod.
- **Access token JWT** de 15 min, assinado com `JWT_SECRET` (mín. 32 caracteres, validado na config), com `iss` e `aud` configurados e claims `sub` (userId), `cid` (clientId) e `role`.
- **Refresh token** opaco, aleatório (`randomBytes(64)`), entregue ao cliente uma vez. No Redis fica só o **hash** (SHA-256) com TTL, associado a uma família de tokens.
- **Rotação:** cada `refresh` invalida o token usado e emite um novo par. **Detecção de reuso:** apresentar um refresh já usado revoga a família inteira.
- **Revogação explícita:** `logout` revoga a família; "sair de todos os dispositivos" revoga todas as famílias do usuário.
- Rotas: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.
- Hook `authenticate` do Fastify: valida `Authorization: Bearer`, devolve 401 se ausente, inválido ou expirado, e preenche o contexto da requisição (`userId`, `clientId`, `role`) no `AsyncLocalStorage` da spec 004.
- Login e refresh usam o perfil de rate limit `critical` (spec 005).
- Respostas de login com a mesma mensagem e tempo similar para "usuário não existe" e "senha errada" (sem enumeração de contas).
- `ADMIN_API_KEY` da spec 003 deixa de ser a única proteção das rotas administrativas.

## Critérios de aceite

- [ ] Teste: login válido devolve access e refresh; senha errada e usuário inexistente devolvem o mesmo 401.
- [ ] Teste: access token expirado, com `aud`/`iss` errados ou assinatura inválida é recusado.
- [ ] Teste: `refresh` devolve par novo e o refresh antigo deixa de funcionar.
- [ ] Teste: reuso de refresh antigo revoga a família (o refresh mais novo também deixa de funcionar).
- [ ] Teste: `logout` revoga; após isso o refresh falha.
- [ ] Teste: o Redis guarda apenas o hash do refresh, nunca o valor original.
- [ ] Teste: `JWT_SECRET` com menos de 32 caracteres impede o boot.
- [ ] Teste de isolamento: usuário do cliente A não acessa recurso do cliente B mesmo com id válido; o mesmo email pode existir em dois clientes sem conflito.
- [ ] Teste: login e refresh retornam 429 ao exceder o limite `critical`.
- [ ] Senha e tokens não aparecem em nenhum log (cobre a redação da spec 004).

## Casos de borda e erros

- Usuário desativado: login e refresh falham; access token ainda válido deixa de ser aceito quando o usuário for desativado (verificar status no `authenticate` ou via lista de revogação curta; decidir e testar).
- Relógio dessincronizado: tolerância pequena (`clockTolerance`).
- Redis fora: `refresh` e `logout` falham com 503 (não aceitar refresh sem poder verificar revogação); `authenticate` continua validando só a assinatura.

## Isolamento entre clientes

O `clientId` vem do token assinado, nunca de header ou corpo da requisição. Testes acima.

## Fora de escopo

- Papéis e permissões (spec 008), SSO/OAuth, MFA, recuperação de senha por email, sessões com cookie para painel admin.

## Decisões e dependências novas

- Dependências: `@fastify/jwt` (ou `jose`; escolher na implementação e registrar aqui), `argon2`.
- **Pergunta:** refresh token entregue no corpo da resposta ou em cookie `HttpOnly`? Depende de como o painel será feito; sugestão para API pura: corpo.
