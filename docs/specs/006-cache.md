# 006 — Cache em duas camadas

- **Status:** esboço (sob demanda: reler contra o código antes de aprovar; gatilho: medição mostrar leitura repetida custosa)
- **Branch:** `spec/006-cache`
- **Depende de:** 002, 003, 004

## Objetivo

Reduzir leituras repetidas ao banco e a APIs externas com cache L1 (memória) e L2 (Redis), sem nunca servir dado de um cliente para outro.

## Comportamento esperado

- Interface `CacheService` em `src/application/` e implementação em `src/infrastructure/cache/`:
  - `get`, `set`, `del`, `getOrSet(key, fetcher, { ttl, tags })` (cache-aside).
  - L1: LRU em memória com tamanho máximo e TTL curto. L2: Redis com TTL.
  - Leitura: L1, depois L2, depois fetcher; ao achar em L2, popula L1.
- **Chave obrigatoriamente com `ClientId`:** o construtor de chaves exige `ClientId` para dado de tenant (`tenant:{clientId}:{recurso}:{id}`); chave global só por função explícita e separada. Impossível montar chave de tenant sem o cliente.
- **Invalidação por tags** com conjuntos Redis (`SADD`/`SMEMBERS`): `invalidateTag(tag)` apaga as chaves associadas em L2 e avisa as outras instâncias por pub/sub do Redis para limpar L1.
- **Proteção contra stampede:** chamadas concorrentes para a mesma chave ausente executam o fetcher uma única vez (single-flight por processo).
- **Falha do Redis:** registra erro e métrica e segue só com L1/fetcher; leitura nunca falha por causa do cache.
- Valores serializados em JSON com validação de tipo ao ler (Zod opcional por chamada) para não confiar cegamente no que está no cache.
- Métricas `cache_operations_total{layer,result}` (hit/miss/set/delete/error) e hit rate calculável.
- **Sem decorators:** usar `getOrSet` explícito (o guia usa `@Cacheable`/`@CacheInvalidate`, que exigem `experimentalDecorators` e escondem a chave; desvio deliberado).
- Aplicar em um caso real e simples como prova: leitura de `Client` por id/slug.

## Critérios de aceite

- [ ] Teste: primeira leitura chama o fetcher (miss), a segunda vem do L1 (hit) sem chamar o fetcher.
- [ ] Teste: com L1 vazio e L2 populado, lê do Redis e repopula L1.
- [ ] Teste: TTL expira em L1 e L2.
- [ ] Teste: `invalidateTag` remove as chaves marcadas, em L2 e L1 (inclusive de outra instância simulada via pub/sub).
- [ ] Teste: 50 chamadas concorrentes na mesma chave ausente executam o fetcher uma vez.
- [ ] Teste: com Redis fora, `getOrSet` devolve o resultado do fetcher e não lança.
- [ ] Teste de isolamento: valor em cache do cliente A nunca é devolvido ao cliente B para o mesmo recurso/id.
- [ ] Teste de tipos: não compila montar chave de tenant sem `ClientId`.

## Casos de borda e erros

- Fetcher que lança: nada é cacheado, o erro propaga.
- `null`/`undefined` retornados pelo fetcher: política explícita (cachear ausência com TTL curto ou não) e testada.
- Valor grande demais: limite configurável e log.

## Isolamento entre clientes

Chaves sempre com `ClientId`; tags também (`tenant:{clientId}:...`). Testes acima.

## Fora de escopo

- Cache HTTP (ETag/`Cache-Control`), CDN, cache de respostas de LLM (spec própria).

## Decisões e dependências novas

- Dependência: biblioteca LRU (`lru-cache`).
