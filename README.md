# Bolão entre amigos

Site de bolão fechado (pt-BR, feito para o celular, principalmente iPhone). O participante palpita **quem ganha** e, se quiser,
um extra: **mais/menos de 2,5 gols** ou **placar exato** (um só). Cada acerto vale o **lucro da odd justa** (odd sem margem − 1).
Sem pagamentos no site. Especificação completa: [CLAUDE.md](CLAUDE.md).

**Stack:** Cloudflare Workers (site + API + horários automáticos, tudo num Worker só) · Supabase (Postgres e login) · API-Football (jogos, odds e placares).

## Ver funcionando agora (sem configurar nada)

```bash
npm install
npm run dev
```

Abra http://127.0.0.1:8787. O `.dev.vars` com `DEV_MEMORY=1` liga o **modo demonstração**: banco em memória com dados de mentira
(admin `admin@demo.local`, jogadores `lucas@demo.local`, `ana@demo.local`…, senha `demo1234`). Esse modo se recusa a rodar fora do `localhost`.

## Colocar no ar (Supabase + Cloudflare)

### 1. Supabase (uns 10 minutos, em https://supabase.com)
1. Crie a conta e um **New project**. Nome: `bolao`. Região: **South America (São Paulo)**. Guarde a senha do banco (você não vai precisar dela agora).
2. **SQL Editor → New query**: cole o conteúdo inteiro do arquivo [schema.sql](schema.sql) e clique em **Run**. Cria as 11 tabelas e deixa tudo trancado (só o servidor do site mexe nos dados). Pode rodar de novo sem problema.
3. **Authentication → Sign In / Providers**: em **Email**, deixe ligado e **desligue "Allow new users to sign up"** (o cadastro é feito pelo servidor do site, na tela "Criar conta").
4. **Project Settings → API Keys** (ou o botão **Connect**): copie a **Project URL** (`https://xxxx.supabase.co`) e a **secret key** (`sb_secret_...`; no formato antigo é a `service_role`). A secret key é um segredo: não vai para o git nem para o chat.

### 2. Configurar o projeto
Em `wrangler.toml`, `[vars]`: troque `SUPABASE_URL` pela Project URL.

### 3. Cloudflare: entrar e publicar
> **Publique pelo terminal (`npm run deploy`), não pelo painel do Cloudflare.** O envio de pasta do painel não aceita projetos com `wrangler.toml`.
> O Wrangler envia só a pasta `public` (18 arquivos) e o código do servidor empacotado num arquivo único (~210 KB no total). Nunca sobe `node_modules`, `.git`, testes nem `schema.sql`.

1. Crie a conta grátis em https://dash.cloudflare.com/sign-up (não precisa de cartão).
2. No terminal, dentro da pasta do projeto:
   ```bash
   npm install
   npx wrangler login      # abre o navegador: clique em Allow
   npm test                # confere que está tudo certo
   npm run deploy
   ```
   Na primeira vez o Wrangler pergunta o nome do seu subdomínio `workers.dev` (escolha um). O endereço do site sai no final:
   `https://bolao.SEU-SUBDOMINIO.workers.dev`. Ele ainda não funciona até o passo 4.

### 4. Cloudflare: guardar as chaves (secrets)
Nada disso vai para o git. Cada comando pede o valor no terminal:

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY   # a secret key do Supabase
npx wrangler secret put SESSION_SECRET         # um texto aleatório; gere com o comando abaixo
npx wrangler secret put API_FOOTBALL_KEY       # dashboard.api-football.com → My Access
npx wrangler secret put ODDS_API_KEY          # the-odds-api.com (grátis, 500/mês): fonte principal das odds 1X2
```
Para gerar o `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 5. Primeiro administrador
```bash
npm run seed:admin
```
Ele pergunta a secret key do Supabase, o e-mail, o nome, o apelido e a senha (mínimo 8 caracteres). Depois entre no site com esse e-mail e senha.

### 6. Endereço do site no Supabase (para "Esqueci a senha")
**Authentication → URL Configuration → Site URL**: coloque o endereço do site (`https://bolao.SEU-SUBDOMINIO.workers.dev`).
Sem isso, o link do e-mail de recuperação de senha não volta para o seu site.

### 7. Conferir
1. **Admin → APIs → Testar API-Football**: mostra o plano, a cota e se a busca de jogos funciona no seu plano.
2. **Admin → Configurações**: defina o limite de jogos por dia e ligue/desligue gols e placar exato.
3. **Cadastro dos amigos:** mande o endereço do site. Cada pessoa toca em **Criar conta** e informa e-mail, telefone e senha (com confirmação).
4. **Admin → Jogos do dia**: escolha os jogos e crie a primeira rodada.

Se mudar algo no código, publique de novo com `npm run deploy` (os dados ficam no Supabase, nada se perde).

## Uso no dia a dia
1. **Admin → Jogos do dia**: a lista vem ordenada por relevância. Marque os jogos (até o limite de jogos por dia que você definiu em **Admin → Configurações**) e clique em **Criar e abrir rodada**. O "dia" vai das 06:00 às 06:00 (horário de São Paulo).
2. Os participantes palpitam até o início de cada jogo (a trava é do servidor). Os palpites dos outros aparecem quando o jogo começa.
3. Odds, placares, pontos e ranking se atualizam sozinhos. Se a API errar, o admin corrige em **Rodadas e resultados**: placar manual, anular jogo, digitar odds, recalcular.

## Comandos
Use o **PowerShell** (aperte a tecla Windows, digite `PowerShell`, abra e entre na pasta com `cd C:caminhodapastaolão`).
As ferramentas (Wrangler, Vitest, tsx) **não ficam instaladas na pasta do projeto**: o `npx` baixa cada uma na primeira vez que você a usa,
e por isso a pasta `node_modules` tem menos de 700 arquivos.

| comando | o que faz |
|---|---|
| `npm run dev` | site local em http://127.0.0.1:8787 (modo demo se `DEV_MEMORY=1`) |
| `npm test` | testes (Vitest): pontos, remoção da margem, trava de horário, login, cadastro, banco… |
| `npm run deploy` | publica no Cloudflare |
| `npm run seed:admin` | cria o primeiro admin (Supabase Auth + tabela users) |

## Limites dos planos gratuitos (e como o projeto lida)
- **API-Football: 100 chamadas/dia e ~10/min.** Só buscamos odds dos jogos escolhidos, dentro de uma janela de horas antes do jogo, com reserva de chamadas para os placares. O painel em **Admin → APIs** mostra o uso.
  O plano grátis pode limitar temporadas/datas: use o botão de teste. Sem odds, o admin pode digitá-las na mão.
- **Workers Free:** 100 mil requisições/dia, 10 ms de CPU e 50 chamadas externas por execução (o código já limita o trabalho por execução).
- **Supabase (Free):** 500 MB de banco e 50 mil usuários ativos por mês; muito acima do que um bolão usa. Projetos parados por 7 dias são pausados, mas o site fala com o banco a cada 15 minutos, então não pausa.
  E-mails de recuperação de senha usam o envio embutido do Supabase, que tem limite baixo por hora: serve para um grupo de amigos.

## Limites de segurança
- **Cadastro:** no máximo 2 por minuto no site todo. **Login:** 5 tentativas erradas por conta a cada 15 minutos (depois, bloqueado até a janela virar). Os limites ficam no banco (tabela `rate_limits`, criada pelo `schema.sql`).
- Para mudar os números, acrescente em `[vars]` do `wrangler.toml`: `LIMIT_SIGNUP_PER_MIN = "2"` e `LIMIT_LOGIN_FAILS = "5"`.

## Notificações no iPhone (opcional)
Só funcionam com o site **adicionado à Tela de Início** (iOS 16.4+): Safari → Compartilhar → Adicionar à Tela de Início → abrir pelo ícone → tocar no sino.
Para ligar: `npx web-push generate-vapid-keys`, ponha a chave pública em `VAPID_PUBLIC_KEY` no `wrangler.toml`, guarde a privada com
`npx wrangler secret put VAPID_PRIVATE_KEY`, troque `VAPID_SUBJECT` pelo seu e-mail (`mailto:...`) e rode `npm run deploy`.
