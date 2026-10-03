# Bolão entre amigos — Especificação para Claude Code

Este é o `CLAUDE.md` do projeto. Para começar, peça:
"Implemente o projeto descrito no CLAUDE.md, etapa por etapa."

## Visão geral
Site de bolão fechado (amigos/família). O participante palpita **quem ganha** (obrigatório) e escolhe um extra: **mais/menos de 2,5 gols** ou **placar exato**.
A pontuação é baseada em **odds congeladas** no início do jogo. Não há pagamentos no site
(o dinheiro é combinado por fora). A interface é em português (pt-BR), mobile-first.

## Stack (Cloudflare + Supabase, planos gratuitos)
- **Cloudflare Workers com Static Assets**: um único Worker serve o frontend (HTML + JS puro, sem build),
  a API REST (Hono) em `/api/*` e os Cron Triggers. Deploy com `wrangler deploy`.
  - Front e API ficam na **mesma origem**, então o cookie httpOnly funciona no Safari/iPhone sem CORS.
    (Pages + Worker separados não servem: `*.pages.dev` e `*.workers.dev` são sites diferentes e o Safari bloqueia o cookie.)
- **Supabase (Postgres)**: banco de dados, em tabelas de verdade (`schema.sql`, um arquivo que se cola no SQL Editor).
  Acessado **somente pelo Worker**, com a chave secreta (`service_role`); o navegador nunca fala com o Supabase.
  Todas as tabelas têm RLS ligado e nenhuma regra de acesso, então a chave pública não enxerga nada.
- **Supabase Auth** (e-mail e senha): senhas, unicidade de e-mail e e-mail de recuperação. Só o Worker fala com ele. Ver "Autenticação".
- **Cron Triggers**: sincronização de jogos, odds e resultados.
- **Secrets** (`wrangler secret put`; no dev, em `.dev.vars`): `SUPABASE_SERVICE_KEY`, `SESSION_SECRET` (assina o cookie de login),
  `API_FOOTBALL_KEY`, `ODDS_API_KEY` (opcional), `VAPID_PRIVATE_KEY`.
  Vars no `wrangler.toml`: `SUPABASE_URL`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.
- Nunca commitar o `.dev.vars` nem chaves.

### Supabase dentro do Worker
- Cliente pequeno em `src/db/supabase.ts` sobre a **API REST** (PostgREST): `get`, `getMany`, `query` (filtros `eq/lt/gt/in`, ordem, limite)
  e `commit`, que envia o lote de escritas para a função `apply_writes` do `schema.sql` (tudo ou nada; `set`, `merge` raso, `delete`,
  `increment`; precondições `must_not_exist` e por versão, que viram HTTP 409 e `ConflictError`).
- Cada coleção é uma tabela; os campos de primeiro nível são as colunas e objetos/listas ficam em colunas `jsonb`. `settings`, `fixtures_cache`
  e `team_cache` guardam o documento todo em `data jsonb`. Datas viram texto ISO na ida e `Date` na volta.
- **Campo sem coluna é descartado em silêncio pelo Postgres.** O teste `test/schema.test.ts` lê o `schema.sql` e falha se o app gravar
  algo que não tem coluna; ao criar campo novo, adicione a coluna no `schema.sql` (e rode o arquivo de novo no SQL Editor).
- A lógica de negócio usa um repositório (`src/db/repo.ts`), não o cliente direto, para ser testável sem banco (`MemoryDb`).

## Fontes de dados (gratuitas)
1. **API-Football (api-sports.io)**, plano free (~100 req/dia):
   - `/fixtures?date=YYYY-MM-DD` → jogos do dia
   - `/odds?fixture=ID` → mercados "Match Winner", "Goals Over/Under" (2.5) e "Exact Score"
   - `/fixtures?id=ID` → placar final, **um jogo por chamada** (o plano grátis recusa `ids=ID-ID-ID`)
2. **The Odds API** (free 500 créditos/mês; secret `ODDS_API_KEY`): **fonte principal** das odds 1X2 (Pinnacle/Betfair,
   `regions=eu`, `markets=h2h`, 1 crédito por pedido, máx. 16/dia). A API-Football fica de reserva para odds e é usada para jogos e placares.
3. Preferir Pinnacle/Betfair quando disponível; senão, a mediana das casas.

**Economia de requisições:** o cron só busca odds dos jogos **selecionados** pelo admin,
nunca de todos. Cache no banco (`fixtures_cache`, `team_cache`) e registro do uso diário da API (`api_usage`).
Orçamento: odds de 10 jogos toda hora passariam de 100 chamadas/dia — atualizar odds só nas horas antes do
kickoff e parar ao atingir uma reserva configurável (ex.: guardar 20 chamadas para placares).
Antes da etapa 3, confirmar na documentação o que o plano free aceita (janela de datas, temporadas, parâmetros
como `last`/`next`); a ficha do time deve funcionar mesmo sem esses dados.

## Relevância dos jogos do dia
Pontuar cada jogo e ordenar para o admin escolher (até o limite de jogos por dia definido em Configurações):
- Peso por liga: Champions/Libertadores/Copa do Mundo = 100; Premier, La Liga, Série A BR,
  Serie A IT, Bundesliga = 90; Ligue 1, Copa do Brasil, Sul-Americana = 80; outras = 40.
- Bônus de clássico/times grandes: lista configurável no admin.
- Mostrar os 30 primeiros, com filtro por liga.

## Pontuação (valores configuráveis no admin)
Palpite por jogo:
- **Vencedor (1X2) — obrigatório.**
- **Extra, à escolha do participante:** *Gols* (Mais/Menos de 2,5) **ou** *Placar exato*.
  O placar precisa ser coerente com o vencedor escolhido (validar no front e no Worker).

Odds justas (sem margem): p_i = 1/odd_i, normalizar por Σp, odd justa = 1/p. Fazer por mercado.
Placar exato: usar a odd de mercado sem margem, se existir; senão, Poisson ajustado ao 1X2 + O/U justos (limite 150).

Pontos em formato de odd: botões mostram a **odd justa** (2 casas); cada acerto vale o **lucro** `odd_justa − 1` (ex.: @1.82 → +0.82). Ranking = soma dos lucros, 2 casas decimais:
- Modo Gols: acertou o vencedor → pts do vencedor; acertou gols → soma os pts do O/U.
- Modo Placar: acertou o placar → **só** os pts do placar (substitui o vencedor, não soma).
  Errou o placar mas acertou o vencedor → pts do vencedor.
- **Coringa**: 1 jogo por rodada com ×2.
- Odds congeladas no kickoff. Desempate: mais acertos.

## Notificações no iPhone (grátis)
- **Web Push** (iOS 16.4+): funciona só com o site **adicionado à Tela de Início** (PWA).
  Precisa de `manifest.json`, `service-worker.js`, ícones e chaves VAPID.
- Envio pelo Worker com a lib `web-push` compatível com Workers (ex.: `@block65/webcrypto-web-push`); guardar as inscrições na coleção `push_subs` (`user_id, endpoint, p256dh, auth`).
- Gatilhos (Cron): rodada aberta; 30 min antes do 1º jogo para quem não palpitou; rodada encerrada com posição no ranking.
- Tela "Como ativar no iPhone": Safari → Compartilhar → Adicionar à Tela de Início → abrir pelo ícone → tocar no sino.

## Regras
- O palpite pode ser editado até o kickoff. Depois disso fica travado no servidor (validar a hora no Worker).
- Os palpites dos outros só ficam visíveis depois do kickoff.
- Resultado: automático pela API, mas o admin pode sobrescrever manualmente
  (flag `manual_override`).
- Jogo adiado ou cancelado: o admin marca como anulado e ninguém pontua.

## Autenticação (Supabase Auth)
Senhas, unicidade de e-mail e recuperação de senha ficam com o Supabase Auth; o Worker não guarda hash.
- Cadastro **aberto** (sem convite): a tela "Criar conta" pede e-mail, telefone (com DDD), senha e confirmação (olhinho para ver a senha), e
  um apelido opcional (sem ele, vem do e-mail). É **feito pelo Worker** (`POST /api/cadastro`): cria o usuário pela API de administração do
  Auth (`POST /auth/v1/admin/users`, já confirmado; o Auth recusa e-mail repetido) e grava `users/{id}` com o telefone só em dígitos.
  Se a gravação falhar, apaga o usuário recém-criado. Depois o servidor já grava o cookie de login.
- No painel do Supabase, deixar "Allow new users to sign up" **desligado**: o cadastro passa só pelo Worker. O Worker recusa todo usuário
  do Auth que não tenha linha em `users`.
- Login: `POST /api/entrar` manda e-mail e senha; o Worker confere no Supabase (`/auth/v1/token?grant_type=password`) e grava um **cookie
  de sessão próprio**: JWT HS256 assinado com `SESSION_SECRET`, validade de 14 dias, httpOnly, `Secure`, `SameSite=Lax`.
  Validar o cookie não usa rede. Logout apaga o cookie.
- "Esqueci a senha": `POST /api/senha/esqueci` → `/auth/v1/recover` (resposta igual exista o e-mail ou não). O link do e-mail volta ao site
  (Site URL do Supabase) com `#access_token=…&type=recovery`; a tela de senha nova manda o token para `POST /api/senha/nova`,
  que troca a senha em `PUT /auth/v1/user` com o token do link.
- **Limites rígidos** (no banco, não na memória do Worker, que não é compartilhada entre execuções): cadastro **2 por minuto** no site todo; login **5 tentativas erradas por conta a cada 15 minutos** (acertar zera a contagem; a 6ª tentativa já cai em "bloqueado por N minutos"); "esqueci a senha" 3 por hora por e-mail. Cada vaga é uma linha `rate_limits/{chave}:{janela}:{n}` criada com "só se não existir", então duas pessoas ao mesmo tempo nunca pegam a mesma vaga. Padrões mudam com as vars `LIMIT_SIGNUP_PER_MIN` e `LIMIT_LOGIN_FAILS` no `wrangler.toml`. Cadastro com dados inválidos não gasta vaga.
- Papéis: `admin` e `player`, guardados em `users.role`. O Worker lê o usuário a cada 30 s por isolate (cache curto), então
  promover/remover vale quase na hora.
- O primeiro admin é criado por `npm run seed:admin` (cria o usuário no Auth e grava a linha em `users` com `role: admin`).

## Banco (Supabase / Postgres)
Tabelas em `schema.sql`. Datas em `timestamptz` (UTC). O "id" de cada linha é texto.
```text
users          id (= id do Supabase Auth), name, nickname, email (único), phone, role('admin'|'player'), edits[jsonb], created_at
rounds         id (AAAA-MM-DD do dia do bolão), title, date, status('draft'|'open'|'closed'|'finished'), created_at, match_ids[jsonb]
matches        id, round_id, api_fixture_id, league/home/away[jsonb], kickoff_utc, status, home_goals, away_goals,
               manual_override, voided, relevance, odds[jsonb] (ao vivo), frozen_odds[jsonb] (congeladas), extras_frozen[jsonb],
               live[jsonb] (placar ao vivo: home, away, status, elapsed, at)
predictions    id ({matchId}_{userId}), user_id, match_id, round_id, pick_1x2('1'|'X'|'2'), mode('ou'|'cs'|null),
               pick_ou, home_goals, away_goals, joker, points, hits, parts[jsonb], created_at, updated_at
               -- a tabela tem uma restrição: gols OU placar exato, nunca os dois
standings      id (round_{id} | month_{AAAA-MM} | all), scope, month, rows[jsonb], zebra, streaks, seq, start, updated_at
settings       id ('app'), data[jsonb]        -- multiplicadores, coringa, limite de odd, pesos das ligas, limites...
api_usage      id ({AAAA-MM-DD}_{provedor}), date, provider, calls   -- incremento atômico
push_subs      id (sha256 do endpoint), user_id, endpoint, p256dh, auth, created_at
fixtures_cache id (AAAA-MM-DD), data[jsonb]   -- jogos do dia do calendário com a relevância
team_cache     id (id do time), data[jsonb]   -- últimos 5 e próximos 3 jogos (validade ~12 h)
rate_limits    id ({chave}:{janela}:{n}), created_at   -- vagas dos limites de cadastro e login (o cron apaga as antigas)
questions      id, date, kind('pergunta'|'basquete'|'ufc'), title, options[jsonb {id,label,odd}], closes_at, result, voided, created_at
suggestions    id, kind('voto'|'texto'), user_id, date, fixture_id, label, text, created_at
comments       id, match_id, round_id, user_id, text, created_at
reactions      id ({palpite}_{usuário}_{emoji}), prediction_id, match_id, round_id, user_id, emoji, created_at
championships  id, name, start_date, end_date, prize, created_at
answers        id ({questionId}_{userId}), question_id, user_id, date, option_id, points, hits, created_at, updated_at
```
Mercados: `1X2`, `OU25` (`over`,`under`) e `CS` (`2-1` etc.). A odd bruta e a justa ficam dentro do jogo:
`odds = { "1X2": { source, fetched_at, raw: {"1": 2.10, "X": 3.40, "2": 3.60}, fair: {…} }, "OU25": {…}, "CS": {…}, model: {lh, la} }`.
- Toda tabela tem `version` (sobe a cada escrita), usada nas precondições contra escrita concorrente.
- **Ranking materializado**: o cálculo de pontos reescreve as linhas de `standings`; abrir o ranking custa 1 leitura.
- Índices simples nas colunas filtradas (`round_id`, `user_id`, `match_id`, `status`, `date`, `scope`+`month`).

## Crons (horários em UTC)
- `0 9 * * *` → busca os jogos do dia e calcula a relevância.
- `0 * * * *` → atualiza odds dos jogos selecionados; congela as odds de quem começou (copia `odds` → `frozen_odds`).
- `*/15 * * * *` → busca placares de jogos terminados, calcula pontos, reescreve `standings` e fecha a rodada.

Um único `scheduled()` no Worker escolhe a tarefa por `event.cron`.

## Visual — esportivo editorial
As duas imagens de referência (perfil de atleta e dashboard de apostas) foram removidas do repositório; o resultado final seguiu o artefato
"Bolão da Galera" em azul (ver as notas no fim). O texto abaixo descreve a inspiração original.

**`01-perfil-atleta.jpg`** — perfil de atleta, claro e editorial
- Tipografia gigante e condensada: nome em duas linhas bem pesado, número enorme em vermelho, nome do time
  gigante e esmaecido ao fundo (marca d'água).
- Blocos de estatística azul-marinho: rótulo pequeno em caixa-alta, número grande branco e seta de tendência;
  os blocos avançam sobre a borda do card de baixo.
- Linhas "rótulo → valor" com divisória fina; card com abas "Último jogo / Próximo jogo" (escudos, placar,
  FINAL, data); carrossel com setas ← →.
- Usar em: ficha do time, estatísticas do participante, detalhe do jogo e topo do ranking (líder em destaque).

**`02-dashboard-apostas.jpg`** — dashboard de apostas, escuro
- 3 colunas: menu lateral de campeonatos (ícone, nome, contagem), lista de jogos agrupada por campeonato
  com cabeçalho recolhível, cupom à direita.
- Banner do jogo em destaque com corte diagonal, escudos, horário e botão em pílula.
- Abas segmentadas (Todos / Abertos / Encerrados); odds 1 · X · 2 em chips arredondados; selecionada = preenchida na cor primária.
- Card "ao vivo" com escudos grandes, placar e selo vermelho.
- Cupom: contagem em pílula, palpite escolhido, stepper −/+ do placar, resumo ("vale X pts") e botão largo "Salvar palpites".
- Usar em: rodada atual (desktop e mobile), cupom e como base do tema escuro.

Sem fotos de atletas: o papel da foto recortada e do banner fica com escudos grandes + nome do time gigante ao fundo.

**Tokens** (tema claro e escuro)

| token | claro | escuro |
|---|---|---|
| fundo | #F4F4F2 | #0E0F12 |
| superfície | #FFFFFF / #F2F2F2 | #17181C / #1F2126 |
| texto | #111111 | #F2F3F5 |
| secundário | #444444 / #767676 | #A0A4AD / #7C818C |
| linhas | #E2E2E2 | #2A2C33 |
| primária — odd selecionada, botões, blocos de estatística | #17408B | #3D5AFE |
| destaque — números grandes, ao vivo, coringa | #D7263D | #F0435A |
| acerto | #1B998B | #2EC4B6 |
| barra superior | #111111 | #0E0F12 |

- Fontes: Saira Condensed (títulos, times, números, odds; 700–800 nos números gigantes) + IBM Plex Sans (texto e interface).
- Cards com cantos de ~16px, chips e botões em pílula; sombras suaves no claro, bordas sutis no escuro.
- Layout: desktop com menu lateral, lista de jogos e cupom à direita (ref. 2); mobile com chips de campeonato,
  barra inferior e cupom fixo.
- Escudos oficiais via API-Football; ficha do time com últimos 5 e próximos 3 jogos (ref. 1).

## Telas
**Participante**
- Rodada atual (ref. 2): cards dos jogos com escudos, horário, odds 1X2 e um input de placar (+/−).
  Mostrar "vale X pts se acertar exato" com base na odd atual.
- Entrar, criar conta (e-mail, telefone, senha e confirmação) e "Esqueci a senha".
- Meus palpites / histórico.
- Ranking: rodada, mês e geral (ref. 1 no topo, com o líder em destaque).
- Detalhe do jogo depois do kickoff: palpites de todos e pontos de cada um.

**Admin**
- Jogos do dia ordenados por relevância → selecionar jogos (até o limite do dia) → criar e abrir a rodada.
- Tela de resultados: placar manual, anular jogo, recalcular pontos.
- Usuários: listar, remover (apaga no Auth e em `users`), promover a admin.
- Configurações: multiplicadores, coringa on/off, limite de odd, pesos das ligas.
- Painel de uso das APIs (chamadas hoje / limite).

## Extras (fase 2)
- Botão "compartilhar ranking no WhatsApp" (link `wa.me` com texto pronto).
- Tema claro/escuro e PWA (ícone na tela inicial).
- Estatísticas (blocos da ref. 1): % de acerto, maior zebra acertada, melhor rodada.

## Limites dos planos gratuitos
- Supabase (Free): 500 MB de banco; projetos parados por 7 dias são pausados (o cron de 15 minutos mantém o site ativo). O e-mail de recuperação usa o envio embutido, com limite baixo por hora.
- Workers Free: 100 mil requisições/dia, 10 ms de CPU por invocação, até 5 crons por conta (usamos 3).
  A lista de jogos do dia pode ser grande: filtrar cedo ou buscar por liga se o cron estourar a CPU.
- API-Football free: ~100 chamadas/dia (ver orçamento em "Fontes de dados").

## Etapas de implementação
1. Estrutura do projeto (Worker com Static Assets), `wrangler.toml`, cliente REST do Supabase, `schema.sql`,
   script `seed:admin` e um README com o passo a passo de configuração (criar o projeto no Supabase, rodar o `schema.sql`,
   copiar a URL e a secret key, `wrangler login`, secrets, chaves VAPID).
2. Autenticação (Supabase Auth + cookie de sessão) e cadastro.
3. Integração API-Football + relevância + tela admin de seleção.
4. Palpites com trava no kickoff.
5. Odds, remoção da margem e congelamento.
6. Resultados, cálculo de pontos e ranking (standings materializados).
7. Polimento mobile seguindo as referências visuais, e depois os extras.

Cada etapa deve ter testes (Vitest) para o cálculo de pontos, a remoção da margem e a trava de horário
(e, na etapa 2, para a validação do session cookie e do cadastro).

## Notas de implementação (o que ficou diferente do plano acima)
- **Feito:** todas as etapas 1–7, os extras da fase 2 (WhatsApp, tema claro/escuro, PWA, estatísticas) e as notificações push.
- **The Odds API é a fonte principal do 1X2** (`src/services/oddsapi.ts`), para poupar a API-Football (que fica para placares). Liga mapeada para a chave do esporte, jogo achado por nome dos times + horário (±2 h), prefere Pinnacle/Betfair, senão mediana. Só `h2h` (1 crédito), no máximo 16 pedidos/dia (~480 dos 500 créditos/mês). Sem O/U de mercado, o Mais/Menos 2,5 justo vem do Poisson ajustado ao 1X2 (fonte "modelo"). Sem chave, liga não mapeada, jogo não achado ou cota do dia gasta → API-Football. O admin ainda pode digitar as odds (fonte "manual").
- **Plano grátis da API-Football não aceita `ids`** ("Free plans do not have access to the Ids parameter"): placares e ao vivo usam `/fixtures?id=X`, uma chamada por jogo (ao vivo: até 4 jogos por atualização).
- **API-Football grátis:** ~10 chamadas por minuto além das 100/dia. Ao criar a rodada só as 4 primeiras odds são buscadas na hora (com pausa
  entre chamadas); o cron horário completa o resto. As odds automáticas param quando sobra só a reserva (padrão 25 chamadas, para placares).
  O plano grátis pode restringir temporadas/datas: `Admin → APIs → Testar` mostra o erro real da API.
- **Odds e o limite de 10 ms de CPU do Workers grátis:** a resposta da API com todas as casas passa de 190 KB, e só lê-la e calcular o modelo estourava o limite (as odds nunca chegavam). Agora cada pedido pede **uma casa só** (Pinnacle, ~6 KB; se ela não tiver o jogo, Bet365), o placar exato vem do Poisson quando a casa não traz o mercado, e a busca do Poisson usa grades cada vez mais finas (~350 avaliações em vez de ~2.500). Cada execução processa **1 jogo** de odds (cron horário e cron de 15 min). Ao criar a rodada, a tela do admin busca as odds jogo a jogo (um pedido por jogo, ~6,5 s entre eles) e mostra o erro real se algum falhar.
- **Placar ao vivo:** quando alguém abre a rodada e há jogo em andamento, o Worker faz **uma chamada por jogo em andamento** à API-Football (`/fixtures?id=X`, até 4) e grava `matches.live`. Reservada no banco antes de chamar: no máximo **1 chamada a cada 5 minutos por rodada**, não importa quantas pessoas olhem; respeita a reserva de chamadas dos placares finais. Em horário de jogo gasta no máximo ~12 chamadas por hora. A tela atualiza a cada 1 min enquanto há jogo rolando. O **resultado oficial** (pontos) continua só do cron, `score.fulltime`.
- **Odds congelam:** a tela avisa no topo ("congelam no início da partida"), em cada jogo ("odd justa · congela às 20:13") e depois do início ("odd congelada no início").
- **Ganho por rodada:** `GET /api/ranking/rodadas` junta os rankings já materializados das últimas 10 rodadas (uma tabela participante × rodada no Ranking; em "Meus palpites" cada rodada mostra o ganho dela).
- **Perfil:** apelido, telefone e senha podem ser alterados **uma vez cada** pela própria pessoa (`users.edits`); depois só o admin (Admin → Usuários → Editar, com "Liberar nova alteração"). Trocar a senha confere a senha atual (conta como tentativa de login) e usa a API de administração do Auth. O ranking mostra sempre o apelido de agora. Apelidos são únicos (sem maiúsculas/acentos).
- **Foco no Brasileirão:** só as Séries A, B, C e D (ids 71, 72, 75, 76, país "Brazil") têm relevância fixa no topo (A 1000 > B > C > D 970), acima de qualquer outro campeonato, e são sempre guardadas além do corte de 150. O resto do futebol brasileiro (estaduais, sub-20, feminino) entra como qualquer liga. Relevância recalculada ao ler o cache. Filtro "Brasileirão: Séries A, B, C e D" no admin.
- **Perguntas do dia** (`questions`, `answers`): eventos com odds digitadas pelo admin, do tipo `pergunta` (ex.: eleição), `basquete` ou `ufc` (outros esportes depois). Uma opção por pessoa até `closes_at` (hora do servidor); as escolhas dos outros só aparecem depois de fechar. Acerto vale `odd − 1` (as odds digitadas já são as que valem). Dar o resultado fecha a pergunta e grava `standings/questions_{dia}` com scope "round", que entra sozinho no ranking do mês e no geral (não no ranking de uma rodada de jogos). Admin → Perguntas do dia: criar (opções "Nome = odd", uma por linha), editar (não apaga opção já escolhida), "Deu esta", anular, excluir. Na tela de início a seção fica acima dos jogos.
- **Limites sem a tabela:** se a tabela `rate_limits` ainda não existir (schema.sql não rodado), o limite libera e registra o erro em vez de travar o login.
- **Rodada de hoje:** a tela de início mostra só a rodada do dia do bolão de hoje; rodadas de dias anteriores aparecem como "encerrada" (`roundSummary`). Jogo começado há mais de 150 min sem resultado mostra "Aguardando resultado". Sem rodada hoje: "Sem rodada hoje" com as Perguntas do dia, votos em jogos (`fixtures_cache` de hoje e amanhã, até 24) e sugestão escrita (5 por pessoa por dia) — tabela `suggestions`; o admin vê em Admin → Pedidos.
- **Comentários e reações** (`comments`, `reactions`): comentários em cada jogo (280 letras, 6 por minuto por pessoa; o autor ou o admin apagam). Reações (🔥 😂 👏 😱 🤡) aos palpites da galera só depois do apito (antes ninguém vê os palpites), nunca ao próprio, clicar de novo tira.
- **Campeonatos** (`championships`): nome, período e premiação/regras. O ranking do campeonato é calculado na leitura somando `standings/round_{id}` das rodadas do período e `standings/questions_{dia}`; aba "Campeonato" no Ranking. O geral continua somando tudo.
- **Excluir rodada** (Admin → Rodadas → Excluir): apaga jogos, palpites, comentários, reações e o ranking da rodada, e refaz mês e geral. **Buscar placares agora**: pega o placar de jogos terminados sem resultado, sem o limite de 36 h do automático.
- **Placar:** vale o placar dos 90 minutos (`score.fulltime`), que é o que os mercados 1X2, O/U e placar exato liquidam.
- **Odds do placar exato:** mercado sem margem quando a API traz esse placar; senão Poisson ajustado ao 1X2 (+ O/U), com teto configurável (150).
- **Acertos (desempate):** vencedor e extra contam 1 cada; placar exato conta 1 (substitui o vencedor).
- **Modo demo:** `DEV_MEMORY=1` no `.dev.vars` usa banco em memória e login falso, só em localhost (recusa em qualquer outro host).
- **Plano grátis do Workers:** 50 subrequests por execução; por isso os crons limitam quantos jogos/pushes processam de uma vez.
- **Dia do bolão = 06:00 → 06:00 (São Paulo).** Jogos de madrugada pertencem ao dia anterior. A rodada e o mês do ranking usam esse dia. O cron das 09:00 UTC (06:00 em SP) busca o dia novo (2 chamadas: o dia do calendário e o seguinte, filtrados pela janela).
- **Limite de jogos por dia:** `maxMatchesPerDay` (Admin → Configurações, padrão 10, de 1 a 30). Soma os jogos de todas as rodadas do mesmo dia do bolão; o servidor recusa passar do limite. Não há mínimo além de 1 jogo.
- **Maior zebra vista:** maior odd acertada no vencedor (1X2) ou no placar exato (gols 2,5 não conta), guardada nos rankings da rodada, do mês e geral, e no perfil de cada participante.
- **Palpite de placar exato:** o vencedor sai do placar (não dá para escolher 2x1 com "empate"); no modo gols, o vencedor é escolhido à parte. Os palpites são salvos automaticamente.
- **Ranking de sequência:** vencedores (1X2) certos em sequência, jogo a jogo em ordem de horário (atual e recorde), para rodada, mês e geral. Não palpitar conta como erro; jogo anulado não conta; jogos anteriores à entrada da pessoa não contam. Fica materializado em `standings` (`seq` por rodada, `streaks` em cada ranking).
- **Extras ligados/desligados pelo admin a qualquer momento:** `goalsEnabled` e `scoreEnabled` (interruptores no topo do Admin e em Configurações). Todas as combinações valem: os dois, só um ou nenhum (só o vencedor). O extra passou a ser **opcional** (o participante pode ficar só com o vencedor). Extra desligado some do palpite e não pontua; o servidor recusa gravar extra desligado. Jogos que já começaram guardam os extras que valiam no início (`extras_frozen`), então mudar o interruptor não altera jogo em andamento ou já pontuado.
- **iPhone:** botões com pelo menos 44 px, campos com fonte de 16 px (o Safari não dá zoom), áreas seguras do notch/barra inferior, hover só com mouse, rolagem do fundo travada em janelas, e os palpites são salvos também ao sair do app (o iPhone suspende a página).
- **Navegar entre rodadas:** `/api/rodadas/:id` (como `/api/rodada/atual`) devolve `outras` (as mais recentes, sempre incluindo a que está aberta) e `atual`; a tela mostra "Você está vendo uma rodada anterior · Voltar para a rodada atual" e marca a rodada atual na lista.
- **Placar exato errado + vencedor certo:** vale o vencedor (a tela mostra os dois valores antes do jogo e avisa depois). Placar exato certo vale só o placar.
- **Gols OU placar exato, nunca os dois:** a tela troca de um para o outro limpando o que sobra, e o servidor recusa palpite com `pick_ou` e placar juntos ("Escolha gols OU placar exato, não os dois").

## Alterações recentes (outubro/2026)
- **The Odds API integrada e virou a fonte principal do 1X2** (`src/services/oddsapi.ts`, teste `test/oddsapi.test.ts`). Liga → chave do
  esporte por lista fixa (Brasileirão A/B, Copa do Brasil, Libertadores, Sul-Americana, Champions, Europa/Conference, Premier, Championship,
  La Liga, Serie A, Bundesliga, Ligue 1, Portugal, Holanda, Argentina, Copa do Mundo, Eliminatórias Europa/América do Sul, Nations League,
  Eurocopa, Copa América, amistosos). A lista oficial (`/v4/sports`, não gasta crédito) é lida 1×/dia e guardada em
  `fixtures_cache/oddsapi-sports-AAAA-MM-DD`; a chave fixa só vale se existir nela, senão procura a liga pelo nome.
  Admin → APIs mostra se a chave está configurada e quantos pedidos foram usados no dia (provedor `the-odds-api` em `api_usage`).
- **Mais/Menos 2,5 do modelo:** quando a fonte não traz O/U, `buildOdds` gera a odd justa a partir do Poisson ajustado ao 1X2 (fonte "modelo").
- **Placares sem `ids`:** `fixturesByIds` faz um `/fixtures?id=X` por jogo; o cron de resultados processa lotes de 5 e o ao vivo até 4 jogos
  (`LIVE_MAX_MATCHES`) por atualização.
- **Design:** o canvas https://claude.ai/artifact/BG1q9GpXuv9fXmixqct5YP tem as telas de apresentação/"Como funciona" (D, E, F) e o
  "Hero no padrão do site", todas com os tokens de `public/styles.css` (cantos de 4–6 px, Saira até 700, tema escuro #121212).
- **Implementado em outubro/2026 (a partir de `docs/pedidos-pendentes.md`):**
  - **Sem coringa**: o servidor ignora `joker` e grava `false` (a coluna fica por causa dos dados antigos); cálculo, configurações e telas sem ele.
  - **Sem desempate**: pontuação igual divide a posição (1º, 1º, 3º); `hits` continua só como estatística.
  - **Ranking de sequência removido** (`lib/streaks`, `seq`/`streaks` deixam de ser gravados); a **maior zebra fica**.
  - Jogo adiado/cancelado aparece como **"excluído da rodada"** (mesmo comportamento: ninguém pontua).
  - **Obrigatório por rodada** (`rounds.required`): `winner` (só o vencedor) ou `winner_goals` (vencedor + gols: O/U ou placar exato). O servidor recusa o que faltar; o admin escolhe ao criar e pode mudar na tela da rodada.
  - **Perguntas extras** (antes "Perguntas do dia"); basquete e UFC continuam em espera.
  - **Competição paga opcional** (`championships.fee`): só texto do valor combinado; o app não recebe pagamento.
  - **Campeonato de confrontos 1×1** (`src/lib/tournament.ts`, colunas `format`, `legs`, `groups`, `advance`, `goal_step`, `participants`): pontos corridos, grupos, mata-mata ou copa (grupos + mata-mata), só ida ou ida e volta. Cada dia com rodada no período é uma rodada do campeonato; o lucro do dia (rodadas + perguntas extras do dia) vira gols: `piso(lucro / goal_step)`. Vitória 3, empate 1; classificação por pontos, vitórias, saldo e gols pró (tudo igual divide a posição), **reduzida** (pos, nome, P, J, SG) e **completa** (P, J, V, E, D, GP, GC, SG, últimos 5 em bolinhas). Calculado na leitura, nada gravado. Sem formato = ranking de pontos do período, como antes.
  - **Página de entrada** (`public/js/landing.js`): hero no padrão do site (prancheta "Hero no padrão do site") + "Como funciona" em 4 passos (prancheta D) com exemplos de pontos (tudo certo, um acerto, nenhum, placar exato, placar errado com vencedor certo), tom brincalhão e direto, sem avisos do iPhone.
- **Logo:** bola própria no estilo da Trionda (faixas curvas vermelha, verde e azul, cápsula azul com estrelas e "BOLÃO"), sem emblema da FIFA nem marcas. Ícones em `public/icons/` (favicon e `ball-64.png` sem texto; ícones do app e prévia do link com o nome).
- **Skill `mapa-do-projeto`** (`.claude/skills/mapa-do-projeto/SKILL.md`): mapa do projeto, preferências do dono, fluxo de publicação e decisões em aberto. Ler no início de cada sessão e manter atualizado.
- **Ainda em aberto (decisão do dono):** a regra lucro → gol definitiva (hoje: `goal_step`, padrão 1 ponto = 1 gol, ajustável por campeonato) e os **pênaltis** do mata-mata (hoje, provisório: mais acertos no confronto e depois a melhor cabeça de chave).

## Migração para o Supabase e enxugamento (o que mudou)
- **Firebase saiu por completo** (Firestore, Auth, `firebase-tools`, regras e índices). O banco agora é o Postgres do Supabase e o login é o Supabase Auth.
  O cookie de login passou a ser um JWT próprio (HS256, `SESSION_SECRET`), sem certificados do Google.
- **Removidos por serem dispensáveis:** a demonstração em arquivo único (`demo/`, `build-demo`), os geradores de ícones e de chaves VAPID
  (para as chaves VAPID use `npx web-push generate-vapid-keys`) e as imagens de referência em `docs/referencias`. Os ícones prontos do app ficam em `public/icons`.
- **Mantidos de propósito:** o modo demonstração em memória (`DEV_MEMORY=1`), que os testes usam, e as notificações push.
- **Testes do SQL:** o `schema.sql` (incluindo a função `apply_writes`) foi executado num Postgres embutido (PGlite, fora do projeto) com casos de conflito,
  atomicidade, incremento, tabelas de documento, a restrição gols OU placar e a segurança (anon não lê nada). O teste `test/schema.test.ts` garante que
  todo campo gravado pelo app tem coluna.
- **Pasta enxuta (`node_modules` com menos de 700 arquivos):** só as 3 dependências de execução ficam instaladas (`hono`, `jose`, `@block65/webcrypto-web-push`). Wrangler, Vitest e tsx rodam por `npx` (`npm run dev`, `npm run deploy`, `npm test`, `npm run seed:admin`), baixados uma vez para o cache do npm, fora do projeto. Sem TypeScript instalado, não há mais `typecheck`; o `tsconfig.json` só ajuda o editor. Não há `vitest.config.ts` (valem os padrões). No Git Bash o `npm test` pode travar; use o PowerShell.
