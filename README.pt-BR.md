# Continuar automático depois de queda de conexão

Extensão Spindle para o [Lumiverse](https://github.com/prolix-oc/Lumiverse) que
aperta o **Continue** por você quando uma resposta morre no meio porque a
conexão com o provedor caiu — e **nunca** aperta quando o erro foi de dinheiro,
credencial, moderação ou requisição malformada.

Read in [English](README.md).

## Por que ela existe

O Lumiverse já se recupera sozinho de um tipo de queda. Se o **navegador** perde
o servidor, a geração continua rodando na pool do backend e o cliente
ressincroniza na reconexão, quando a aba volta a ficar visível, ou quando você
reabre o chat. Nada se perde e nenhum Continue é necessário.

O caso descoberto é o outro: o **servidor** perder o provedor no meio do stream.
Aí o Lumiverse salva o texto que chegou como mensagem parcial, mostra a linha de
erro no chat, e espera alguém apertar Continue. Se você não estava na frente do
teclado, uma resposta de dois mil tokens fica pela metade até você voltar.

Esta extensão aperta o Continue — mas só quando o erro realmente parece queda de
conexão.

## O que ela nunca repete

A decisão fica em [`src/error-policy.ts`](src/error-policy.ts) e é *fail-closed*:
o erro só é repetido quando bate na lista de permissão de falhas passageiras, e a
lista de bloqueio é checada primeiro e vence. **Erro que ela não reconhece fica
quieto.**

Nunca continua em:

- **Dinheiro** — pagamento, crédito insuficiente, cota estourada, limite de
  gasto, limite de plano, fatura, assinatura, saldo insuficiente.
- **Credencial** — chave de API inválida ou ausente, não autorizado, proibido,
  token expirado, conta suspensa ou desativada.
- **Política** — moderação, filtro de conteúdo, conteúdo bloqueado ou
  sinalizado.
- **Requisição impossível** — tamanho de contexto, limite de tokens, modelo
  inexistente, parâmetro inválido, `400`, `404`, `422`.
- **Parada deliberada** — geração que você parou, abort do próprio host, ou a
  que a pool matou depois de 60 minutos sem atividade.
- **Qualquer coisa desconhecida** — nenhuma regra reconheceu, então nada
  acontece.

As regras de dinheiro vencem as de limite de uso de propósito. Provedor gosta de
vestir cobrança de limite de uso (`429 — you exceeded your current quota`), e
isso não pode disparar uma tentativa que te custa outra requisição.

Continua, depois de uma espera curta: `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`,
`ConnectionClosed`, `UND_ERR_*`, `terminated`, `premature close`,
`socket hang up`, `fetch failed`, `502`, `503`, `504`, erro interno do provedor.

Continua, depois de no mínimo 20 segundos: limite de uso de verdade — `429`,
`rate limit`, `overloaded`, "try again later".

Nas configurações você pode acrescentar suas próprias palavras proibidas; elas
são checadas antes de qualquer regra interna.

## Travas de segurança

- **Precisa ter texto parcial.** Sem nada gerado não há o que continuar, e ela
  não dispara. (Tentar do zero seria outra ação.)
- **Só geração `normal` e `continue`.** Swipe e background swipe escrevem num
  slot que pode não ser o selecionado, e o Continue estenderia o texto errado.
  Impersonate e quiet também ficam fora.
- **Só no chat ativo.** O Continue do host age no chat que está aberto, então se
  você saiu do chat durante a espera, ela desiste.
- **Só uma aba.** O host marca na mensagem qual aba começou a geração, e só essa
  aba age. Quando a marca não vem, vale a aba visível, com uma reserva de 15
  segundos no `localStorage`.
- **Nunca em cima de outra geração.** Ela acompanha
  `GENERATION_STARTED` / `ENDED` / `STOPPED` e cancela a espera assim que
  qualquer geração começa nesse chat — inclusive uma sua.
- **Stop é decisão sua.** Um `GENERATION_STOPPED` cancela a espera e zera o
  contador.
- **Teto de tentativas.** Dois continues automáticos por mensagem no padrão,
  com a pausa dobrando a cada tentativa (3s, 6s, …, teto de 120s). Esgotado o
  teto, ela anuncia e para. O contador zera num sucesso limpo, numa mensagem
  diferente, ou depois de 10 minutos sem falha nova.

## Como funciona

A API de backend do Spindle não tem chamada de "continue esta resposta", e não
existe evento de erro de geração. Então ela é uma extensão só de frontend:

1. Assina o `GENERATION_ENDED`, que o host emite também no caminho de erro,
   carregando `errorCode`, a mensagem, o `finish_reason` e o `content` parcial
   que o host acabou de salvar.
2. Classifica a falha, espera, e recheca todas as travas.
3. Dispara o comando do próprio host com
   `ctx.host.surfaces.invoke({ kind: 'command', id: 'action-continue' })` — o
   mesmo comando que a paleta roda, então a resposta sai exatamente como sairia
   num Continue na mão.

Esse comando do host é o motivo de a única permissão pedida ser `generation`.

## Instalar

**Pelo GitHub**, que é como a maioria vai instalar:

1. Abra o **Spindle Panel** (drawer → **Extensions**).
2. **Add Extension** → cole
   `https://github.com/caiohenriquerls/lumiverse-autocontinue` em
   *Install from Source*.
3. Revise a permissão (`generation`) e clique em **Install**.
4. Extensão nova chega desabilitada: ligue o **Enable** e conceda a
   `generation`.

O `dist/frontend.js` está commitado, então a instalação não precisa de build nem
de baixar dependência.

**Pelo disco**, para desenvolver: ponha a pasta em `data/extensions/` no
servidor, e use **Add Extension** → **Import Local** como owner ou admin.

## Configurações

Em **Settings → Continuar automático**:

- **Continuar sozinho depois de queda de conexão** — a chave geral.
- **Máximo de tentativas por mensagem** — de 1 a 5, padrão 2.
- **Esperar antes de continuar** — de 1 a 120 segundos, padrão 3. Dobra a cada
  tentativa.
- **Continuar também quando o limite de tokens cortar a resposta** — desligado
  por padrão. Não houve erro: o modelo só bateu no teto de saída. Ligando isso,
  resposta longa cresce sozinha.
- **Anunciar o que está fazendo** — ligado por padrão.
- **Nunca continuar quando o erro mencionar** — suas palavras, uma por linha.

## Acessibilidade

O aviso é uma região `role="status"` com `aria-live="polite"`, então o leitor de
tela anuncia cada decisão sem roubar o foco: "Conexão caiu. Continuando em
3s…", "Continuando a resposta (tentativa 1 de 2)." e "Parei depois de 2
continues automáticos. A bola está com você." Os textos saem em português
quando o navegador está em `pt`, e em inglês no resto. Dá para desligar o
anúncio — a informação continua indo para o console do navegador.

## Situação

A política de erros tem teste de unidade contra 32 payloads no formato das
falhas reais de provedor (`bun test`). O caminho de ponta a ponta — evento,
espera, invoke — ainda não foi exercitado contra uma queda real de provedor num
Lumiverse rodando, então trate a versão 1.0.0 como funcional porém não provada,
e relate qualquer coisa estranha.

Limites conhecidos:

- Queda que não gerou nenhum token não é continuada, por design.
- O comando Continue do host não tem trava própria para convidado de sala
  multiplayer. Se você joga como convidado, deixe a extensão desligada.

## Desenvolver

```bash
bun install
bun run check   # typecheck + testes + build
```

- `src/error-policy.ts` — a decisão. Pura, sem dependência do host, testada por
  `src/error-policy.test.ts`.
- `src/frontend.ts` — eventos, travas, a espera, o invoke do Continue e o painel
  de configurações.
- `src/strings.ts` — textos em inglês e português.

O `dist/frontend.js` é commitado de propósito: o Lumiverse trata um `dist/`
versionado como pré-compilado e pula tanto o install de dependências quanto o
bundle na hora de instalar. Recompile (`bun run build`) no mesmo commit de
qualquer mudança em `src/`.

## Licença

MIT — veja o [LICENSE](LICENSE).
