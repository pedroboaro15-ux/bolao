# Pedidos pendentes (para aplicar no código depois)

> **Situação (03/10/2026):** os itens 2, 3, 4, 6 e 7 foram implementados (ver "Alterações recentes" no CLAUDE.md). O item 1 só depende de configurar a chave. Continuam em aberto: a regra lucro → gol definitiva e o formato dos pênaltis do mata-mata (hoje há regras provisórias).

Cada item é um prompt pronto para colar numa sessão do Claude Code.

## 1. Configurar a chave da The Odds API
Já implementado (`src/services/oddsapi.ts`). Falta só configurar a chave (nunca commitar):
`npx wrangler secret put ODDS_API_KEY` e `npm run deploy`. Depois conferir em Admin → APIs se a contagem sobe.
Copa do Brasil, Nations League, amistosos etc. já mapeados (lista fixa + busca pelo nome da liga em `/v4/sports`).

## 2. Tela de apresentação + "Como funciona" (mobile, iPhone)
Prompt:
> Crie a tela pública de apresentação e a seção "Como funciona" do bolão, mobile-first (iPhone, 390 px),
> seguindo a opção escolhida no canvas https://claude.ai/artifact/BG1q9GpXuv9fXmixqct5YP
> (linha "Apresentação e Como funciona · celular": D = passo a passo com 4 cartões numerados e lista de regras;
> E = onboarding em 4 cartões deslizantes com "Pular/Próximo" e pontos de progresso; F = editorial clara com
> título gigante e um exemplo de palpite com a conta dos pontos). Use os tokens do CLAUDE.md, Saira Condensed +
> IBM Plex Sans, botões ≥ 44 px. Mostre-a para quem não está logado; botões "Criar conta" e "Entrar" levam às
> telas existentes. O conteúdo explica: vencedor obrigatório, extra opcional (gols OU placar), ponto = odd justa − 1,
> odds congeladas no apito, coringa ×2, edição até o kickoff, ranking rodada/mês/geral, sem dinheiro no site e como
> ativar avisos no iPhone. Opção escolhida: [D | E | F | mistura].
> Use exatamente os tokens de `public/styles.css` (variáveis `--bg`, `--surface`, `--brand`, `--ok`, `--bad`, `--bar`,
> `--font-display`, `--font-body`, raios `--r1`/`--r2`, botões `.btn.primary.block`), não cores novas: cantos retos de 4–6 px
> (sem pílulas), Saira Condensed no máximo peso 700, tema claro/escuro igual ao resto do site.

## 3. Hero no padrão do site
Usar a prancheta "Hero no padrão do site (recomendado)" do canvas como base da tela pública (mesmas classes do
`styles.css`: `.topbar`, `.summary`, `.group`/`.group-h`, `.ev`, `.odd`, `.btn.primary.block`, `.card`).

## 4. Texto do "Como funciona" (respostas do dono)
Perguntas enviadas; colar aqui as respostas e gerar a tela a partir delas:
1. Em uma frase, o que é o bolão para quem nunca ouviu falar?
2. Quem pode participar? Qualquer um com o link ou só convidados?
3. Precisa pagar algo? Como o dinheiro (se houver) é combinado e quem ganha?
4. Quantos jogos tem por dia e quem escolhe esses jogos?
5. Até que horas dá para palpitar e editar?
6. O que é obrigatório palpitar em cada jogo?
7. Como explicar o extra de gols (mais/menos de 2,5) para leigos?
8. Como explicar o placar exato e por que ele substitui o vencedor?
9. Como explicar "odd" para quem nunca apostou?
10. Por que a odd congela no início do jogo?
11. Como funciona o coringa e quando usar?
12. Um exemplo de palpite com a conta dos pontos que você queira mostrar?
13. Como funciona o desempate?
14. O que acontece se eu esquecer de palpitar num jogo?
15. E se o jogo for adiado ou cancelado?
16. Quando vejo os palpites dos outros?
17. Rankings da rodada, do mês e geral: algum prêmio para cada um?
18. O que são o ranking de sequência e a "maior zebra"?
19. Como ativar os avisos no iPhone e quais avisos chegam?
20. Tom do texto: brincalhão, direto ou formal? Alguma regra da galera a incluir?

## 5. NOVA IDEIA: Bolão vira campeonato de pontos corridos (em discussão)
- 8 amigos, turno e returno: 14 rodadas (cada um enfrenta os outros 7 duas vezes), 4 confrontos por rodada.
- Cada rodada é um dia do bolão com os mesmos jogos para todos; o desempenho do dia vira "gols" no confronto.
- Quem faz mais gols vence o confronto: vitória 3 pts, empate 1, derrota 0. Tabela estilo Brasileirão
  (P, J, V, E, D, GP, GC, SG). Desempate: vitórias, saldo, gols pró, confronto direto.
- Pendente decidir: como lucro vira gol, W.O. de quem não palpita, número de participantes diferente de 8, extras
  (artilheiro, mando de campo, copa/mata-mata no fim). Ver a conversa da sessão para as opções.

### Respostas do dono (parte 1)
1. O bolão é uma competição para ver quem acerta mais, quem tem a melhor previsão. Brincadeira entre amigos.
2. Qualquer pessoa pode participar.
3. O app é gratuito. Existem competições pagas; o valor é definido pelos participantes (combinado fora do app).
4. De 4 a 10 jogos por dia (média 7), e de 1 a 3 perguntas extras no fim de semana.
5. Dá para palpitar desde o início do dia até a última partida começar (cada jogo continua travando no seu início? confirmar).
6. É obrigatório o que o admin colocar: só o resultado, ou resultado + gols. O admin vai trazer extras novos.
   (resposta interrompida aqui; faltam 7–20)

Novidades que saíram das respostas (implementar):
- "Perguntas da semana": 1 a 3 perguntas no fim de semana (ex.: quem marca primeiro?), criadas pelo admin.
- Competições pagas opcionais, com valor definido pelos participantes (o app só mostra, sem pagamento).
- O admin define, por rodada, quais palpites são obrigatórios.

### Respostas do dono (parte 2)
7. Gols: "Mais de 2,5" = o jogo tem 3 gols ou mais; "Menos de 2,5" = 2 gols ou menos (somando os dois times).
8. Placar exato: acertar o resultado com os gols dos dois times (2 a 1, 2 a 0, 3 a 1...). Substitui o vencedor porque,
   acertando o placar, você já acertou quem ganhou.
9. Odd: um multiplicador baseado na chance de o evento acontecer (quanto menos provável, maior a odd).
10. A odd congela no início do jogo porque, depois que a bola rola, as coisas acontecem: saiu um gol e a odd despenca.
11. Coringa: SERÁ EXCLUÍDO (ver item 6).
12. (sem exemplo; usar um exemplo nosso)
13. Não tem desempate: empatou, empatou (posições iguais no ranking).
14. Esqueceu de palpitar num jogo? Tudo bem, passa para o próximo; aquele jogo não pontua.
15. Jogo adiado ou cancelado: é excluído da rodada.
16. Palpites dos outros: aparecem quando os jogos começam (depois que você palpitou e a bola está rolando).
17. Prêmio: só se a competição definir.
18. (sem resposta sobre sequência / maior zebra)
19. Avisos no iPhone: NÃO aparecem no "Como funciona" por enquanto.
20. Tom: brincalhão e informal, mas direto.

## 6. Briefing: mudanças de regra decididas
- **Excluir o Coringa** por completo: settings, palpite (`predictions.joker`), cálculo de pontos, telas, textos, testes e o CLAUDE.md.
- **Sem desempate:** pontuação igual = mesma posição no ranking (ex.: 1º, 1º, 3º). Remover "desempate por mais acertos".
- Jogo adiado/cancelado sai da rodada (hoje é "anulado"; manter o comportamento de não pontuar).
- "Como funciona" sem a parte de avisos no iPhone.

## 7. Briefing: formato de CAMPEONATO (substitui o ranking)
- Não há mais ranking de pontos: é um campeonato de confrontos 1 contra 1. O lucro do dia vira gols no confronto.
- Formatos escolhidos pelo admin ao criar a competição:
  - **Pontos corridos / grupo(s)**: só ida ou ida e volta.
  - **Mata-mata**: só ida ou ida e volta.
  - **Copa (estilo Copa do Mundo)**: fase de grupos (só ida ou ida e volta) + mata-mata com os melhores de cada grupo.
- **Classificação** (grupos e pontos corridos) em dois formatos:
  - **Reduzida**: posição, nome, pontos, jogos, saldo.
  - **Completa**: posição, nome, P, J, V, E, D, GP, GC, SG e **últimos 5 confrontos** (V/E/D em bolinhas coloridas;
    se ainda não houver 5, mostra os que já aconteceram).
- **Maior zebra** fica. **Ranking de sequência sai** (difícil de entender): remover telas, cálculo e `streaks`/`seq`.
- "Como funciona" com exemplos de palpite em todas as situações (tudo certo, um acerto, nenhum acerto, placar exato).
- Pendente: regra de lucro → gol (dono ainda pensando).
- Empate no mata-mata: **pênaltis** = provavelmente 4 palpites extras de desempate (formato a definir pelo dono).
  Fora do mata-mata continua sem desempate.
