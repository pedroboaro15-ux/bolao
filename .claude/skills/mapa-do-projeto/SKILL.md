---
name: mapa-do-projeto
description: Mapa do projeto Bolão (site de palpites entre amigos) com onde fica cada coisa, como publicar, preferências do dono e decisões em aberto. Use no início de qualquer sessão sobre o bolão, quando o dono pedir "leia o mapa", ou antes de mexer em código, banco, design ou publicação, para entendê-lo de cabeça fresca.
---

# Mapa do projeto Bolão

Leia este mapa inteiro antes de agir. Depois, conforme a tarefa, abra só o que ela pede (lista em "Onde fica cada coisa").
Se algo aqui contradizer o código, o código vale: confira e **atualize este mapa** no fim da tarefa.

## 1. O que é
Site de bolão entre amigos (pt-BR, feito para iPhone). Cada um palpita **quem ganha** nos jogos do dia; o admin pode exigir
também os **gols** (mais/menos de 2,5) ou deixar gols/placar exato como extra. Acerto vale o **lucro da odd justa** (odd − 1),
com a odd **congelada no apito**. Tem perguntas extras (ex.: eleição), campeonatos de confronto 1×1 e comentários.
Sem pagamento no site: dinheiro, quando houver, é combinado entre eles.

- **No ar:** https://bolao.pedroboaro15.workers.dev
- **Especificação completa e histórico de decisões:** `CLAUDE.md` (leia a seção "Alterações recentes").
- **Pedidos e decisões do dono:** `docs/pedidos-pendentes.md`.

## 2. Como o dono quer ser atendido (importante)
- **Português do Brasil**, direto, sem enrolação. Ele não é programador: explique o efeito, não o código.
- **Faça, não mande fazer.** Atualize os arquivos e entregue pronto; quando algo depender dele (colar SQL, criar chave),
  dê o bloco **pronto para colar**, um comando por bloco.
- **Foco no celular (iPhone):** botões de 44 px+, nada rolando para o lado, teste em 390 px.
- **Foco no futebol, Brasileirão Séries A, B, C e D primeiro.** Basquete e UFC estão em espera (virão com API, como o futebol).
- **Nunca** coloque chaves/senhas em arquivo versionado nem as repita no chat; se ele colar uma chave, recomende trocá-la.
- **Nunca** use marcas de terceiros (FIFA, Adidas, logos oficiais) como identidade do site; desenhe versões próprias "no estilo".
- Teste antes de dizer que está pronto (Vitest + olhar a tela no navegador em tamanho de celular).

## 3. Arquitetura em 30 segundos
- **Cloudflare Worker único** (`src/index.ts`): serve o site (`public/`), a API Hono em `/api/*` e 3 crons.
  Plano grátis: **10 ms de CPU** e 50 subrequests por execução → trabalho pesado é fatiado (1 jogo de odds por execução etc.).
- **Supabase**: Postgres (tabelas em `schema.sql`) + Auth (login). Só o Worker fala com o banco (chave secreta); RLS ligado.
- **APIs de futebol**: API-Football (jogos, placares, reserva de odds; ~100 chamadas/dia) e The Odds API (odds do vencedor,
  se `ODDS_API_KEY` estiver configurada; sem ela volta para a API-Football).
- **Front**: HTML + JS puro, sem build (`public/app.js` = roteador; telas em `public/js/`).

## 4. Onde fica cada coisa
| Assunto | Arquivos |
|---|---|
| Rotas do jogador (rodada, palpites, ranking, perfil, perguntas) | `src/routes/player.ts` |
| Rotas públicas (login, cadastro, senha) | `src/routes/public.ts` |
| Rotas do admin (jogos do dia, rodadas, resultados, odds, usuários, config) | `src/routes/admin.ts` |
| Pedidos, comentários/reações, campeonatos, excluir rodada, buscar placares | `src/routes/extra.ts` |
| Cálculo de pontos | `src/lib/scoring.ts` (sem coringa) · validação do palpite `src/lib/predictions.ts` |
| Odds justas, Poisson, placar exato | `src/lib/odds.ts` |
| Campeonato de confrontos (tabela, grupos, mata-mata) | `src/lib/tournament.ts` |
| Relevância dos jogos (Séries A–D no topo) | `src/lib/relevance.ts` |
| Configurações do admin | `src/lib/settings.ts` |
| Limites de cadastro/login (no banco) | `src/lib/ratelimit.ts` |
| Ranking materializado | `src/services/standings.ts` · recálculo `src/services/results.ts` |
| Rodadas, cache de jogos, odds | `src/services/rounds.ts`, `apifootball.ts`, `oddsapi.ts` |
| Placar ao vivo | `src/services/live.ts` · crons `src/services/cron.ts` |
| Perguntas extras | `src/services/questions.ts` |
| Banco (cliente REST, memória p/ testes) | `src/db/supabase.ts`, `memory.ts`, `repo.ts` |
| Modo demonstração (dados de mentira) | `src/dev.ts` (`DEV_MEMORY=1`, só localhost) |
| Telas | `public/js/round.js` (rodada), `ranking.js` (ranking, campeonato, detalhe do jogo, comentários), `admin.js`, `landing.js` (página de entrada + Como funciona), `questions.js`, `pedidos.js` |
| Visual | `public/styles.css` (tokens claro/escuro, Saira Condensed + IBM Plex Sans) · ícones `public/icons/` (bola clássica preta e branca, domínio público) |
| Tabelas | `schema.sql` (sempre idempotente: `create ... if not exists` + `alter ... add column if not exists`) |
| Testes | `test/*.test.ts` (Vitest; `test/schema.test.ts` falha se o app gravar campo sem coluna) |

## 5. Regras de negócio vigentes (resumo)
- Vencedor obrigatório; por rodada o admin escolhe **só vencedor** ou **vencedor + gols** (`rounds.required`).
- Extra: gols **ou** placar exato, nunca os dois. Placar exato certo vale **no lugar** do vencedor; placar errado com vencedor certo vale o vencedor.
- **Sem coringa** e **sem desempate** (pontos iguais = mesma posição). **Sem ranking de sequência**; a **maior zebra** fica.
- Palpite editável até o jogo começar (trava no servidor). Palpites dos outros só aparecem depois do apito.
- Jogo adiado/cancelado = "excluído da rodada" (ninguém pontua).
- Dia do bolão = 06:00 → 06:00 de São Paulo. A tela de início mostra **só a rodada de hoje**; sem rodada, abre votos em jogos e sugestões.
- Campeonato de confrontos: cada dia com rodada no período = uma rodada; **1 de lucro = 1 gol** (fixo); gols iguais = empate no confronto; as casas decimais do lucro só desempatam a classificação; V=3, E=1.
- Mata-mata empatado: mais lucro na ida+volta; lucro igual = pênaltis com palpite dos dois até o prazo do admin, máquina completa o que faltar (`src/lib/penalties.ts`, rotas em `src/routes/extra.ts`, tabela `shootouts`, tela `public/js/penalties.js`). Goleiro da animação = luva (`public/icons/luva.svg`).
- Sem ficha do time (últimos/próximos jogos): o plano grátis da API não libera. Não mostrar ao jogador explicações técnicas de erro.

## 6. Como publicar (fluxo atual)
1. Trabalhe e faça commit em `C:\Users\Pedro\Downloads\bolão` (branch `master`). Rode os testes no **PowerShell**:
   `npx --yes vitest@5.0.2 run` (no Git Bash pode travar).
2. Copie para o clone do GitHub e envie (o Cloudflare publica sozinho a partir do `main` em ~1 min):
   - clone: `%USERPROFILE%\Documents\GitHub\bolao` → repositório **`pedroboaro15-ux/bolao`** (é ESTE que vai para o ar).
   - copie com `git archive HEAD | tar -x -C <clone>` (no Bash; no PowerShell o pipe binário corrompe), use `git rm` para arquivos
     apagados, **não** envie `.claude/launch.json` nem `.dev.vars`; a pasta `.claude/skills/` pode ir.
3. Confira no ar com `curl` (ex.: o arquivo JS novo contém o texto novo) e a API `/api/saude`.
4. Se mudou `schema.sql`, lembre o dono de **colar o arquivo inteiro no SQL Editor do Supabase e rodar** antes de usar.
- Existe também `pedroboaro15-ux/bol-o` (com hífen), usado por uma sessão na nuvem: só tem um branch antigo, **não publica**.
  O projeto continua no `bolao`. Trabalho vindo de lá entra por merge no repositório local (`git remote nuvem`).

## 7. Comandos úteis
- Testes: `npx --yes vitest@5.0.2 run` (PowerShell).
- Site local de demonstração: servidor `bolao` do `.claude/launch.json` (porta 8787; login demo `admin@demo.local` / `demo1234`).
- Segredos (no Cloudflare, nunca no git): `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `API_FOOTBALL_KEY`, `ODDS_API_KEY`, `VAPID_PRIVATE_KEY`.

## 8. Em aberto (decisão do dono)
- Notificações push: chaves VAPID não configuradas; enviar para muitos de uma vez estoura a CPU do plano grátis (precisa de fila).
- Basquete e UFC: em espera.

## 9. Ao terminar uma tarefa
- Atualize `CLAUDE.md` ("Alterações recentes") e, se mudou algo deste mapa (arquivos, fluxo, decisões), **atualize este SKILL.md**.
- Diga ao dono, em poucas linhas: o que mudou para ele, se está no ar e o que ele precisa fazer (ex.: rodar o `schema.sql`).
