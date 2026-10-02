# AGENTS.md — Credigest

> Contexto deste projeto. O `~/.config/opencode/AGENTS.md` é global; este é
> do Credigest. Se algo aqui estiver errado, corrija.

## O que é

Cobrança por Pix com baixa automática por webhook. Cliente cadastrado →
Pix gerado → cobrança mandada no WhatsApp → dívida quitada sozinha quando o
pagamento cai.

Sem dependência de runtime. Sem build. Sem framework. Node.js +
`node:sqlite` e o resto é arquivo estático servido pelo próprio Node.

## Como mexer

```bash
npm test                          # 72 testes, ~0,4s
npm run migrate                   # cria/atualiza o banco
npm run seed                      # demo, só se o banco estiver vazio
npm start                         # http://127.0.0.1:3000
node db/verificar-vocabulario.js  # migration 005 x código
```

Node **22.5+** (precisa de `node:sqlite` e `--env-file-if-exists`).
Testado no 24.21.

Se `npm.ps1` reclamar de ExecutionPolicy, use
`C:\Program Files\nodejs\npm.cmd`.

## O que NÃO se mexe

### `dominio/` é onde mora o dinheiro

`src/dominio/` só vê **centavos inteiros** e só vê **status interno em
português**. Ela não importa nada de HTTP nem de gateway — nem deveria.
Se um `require` de `http/` aparecer em `dominio/`, algo foi feito errado.

Conversão de texto para dinheiro acontece **na borda**
(`http/rotas/validacao.js:paraCentavos`). Formatação para exibição
acontece **na saída** (`utilitarios/dinheiro.js`).

Já existiu bug de valor por causa disso: a rota convertia `850.00` → `85000`
e o repositório convertia de novo. Dependendo do caminho, o sistema cobrava
R$ 85.000,00. Se aparecer `parseFloat` no domínio, isso voltou.

### Migration aplicada não se edita

O runner guarda checksum e avisa se o arquivo mudou. Não é implicância: é
o que impede alguém "corrigir" uma migration antiga, o banco novo ficar
certo e o banco velho continuar errado, sem ninguém entender por que os
dois se comportam diferente.

Correção de dado entra **sempre** como migration nova.

`002` e `004` são bug corrigido e os comentários lá explicam por quê — não
apague esses comentários, eles são a única documentação do sintoma.

### Dívida não se apaga

Não existe `DELETE /api/dividas/:id` e não deve existir sem pensar muito.
Dívida é registro financeiro. Para não cobrar mais, o caminho é gerar
cobrança menor ou registrar o pagamento.

### Token do webhook não vai para o navegador

`ASAAS_WEBHOOK_TOKEN` é servidor. O botão "simular pagamento" do painel
chama `processarEvento` por dentro, sem passar pela autenticação — mesma
lógica, sem vazar o segredo. Não "simplifique" isso para uma chamada HTTP
ao próprio webhook.

## Decisões que já foram tomadas

**Dinheiro em centavos, sempre.** Dentro do sistema é `int`. Texto com
vírgula só na borda.

**Status em português.** O gateway fala inglês, o banco fala português, a
tradução é `utilitarios/statusGateway.js`. Mais de meio bug de status veio
de pular essa tradução.

**Saldo nunca negativo.** Cliente que pagou a mais tem saldo `0` e a
diferença visível em `valor_pago_centavos`. Negativo na tela vira "a
Credigest deve dinheiro ao cliente", que não é o que saldo significa.

**`pago_em` é a fonte da verdade, não `status_gateway`.** O status é o que
o *provedor* acha e pode demorar ou faltar. `pago_em` só é preenchido pela
transação de baixa, junto com o evento. Regra do caso do WhatsApp já pago
segue essa: `pago_em`, não status.

**Duas camadas de idempotência, e a segunda é a que importa.** Índice
único em `id_evento` cuida do reenvio do mesmo evento. O
`UPDATE ... WHERE pago_em IS NULL` dentro da transação cuida do caso em que
o mesmo pagamento chega com `id_evento` diferente — que o Asaas pode fazer.
Sem o segundo, um clique duplo no botão de simular credita duas vezes.

**Erro nosso responde 200 no webhook.** Se a Credigest cai, o Asaas
reenvia. Se a Credigest responde 500, o Asaas reenvia em loop. Evento
malformado responde 400 (o gateway para de tentar, que é o certo).

**401 é sempre idêntico.** Sem header, token errado e token curto devolvem
a mesma resposta. Se a mensagem diferir entre eles, vaza o formato válido.

**Divergência de valor não bloqueia a baixa.** O dinheiro entrou; recusar
o registro só faz o painel mostrar dívida que o cliente já quitou. Credita
o valor da cobrança e devolve o aviso.

**`vw_dividas` filtra `pago_em IS NOT NULL` dentro do subselect.** Sem
isso, `COALESCE` transforma cobrança pendente em dinheiro recebido e o
painel mostra "pendente" e "deve R$ 0,00" na mesma linha.

## Como testar

Testes ficam em `test/` e rodam em memória (`:memory:`). Nenhum toca o
`dados/credigest.db`.

```bash
npm test
node --test test/http.test.js     # só a camada HTTP
```

`test/helpers/banco.js` silencia o log. Os testes de fluxo usam o gateway
simulado de propósito — determinismo importa mais que realism aqui.

**Rodar não é verificar.** Depois de mexer em regra de negócio, olha a
saída real. `npm run inspect` abre o banco e mostra os totais; se a
aritmética do painel não fechar, o teste passou mas o sistema está errado.

## Achados que já custaram tempo

Guardados aqui porque o padrão se repete, e o padrão é sempre o mesmo:
**bug que não dá erro.**

- `status_gateway` em inglês fez o índice de "um Pix por dívida" nunca
  proteger nada. Duas chamadas simultâneas, dois Pix, cliente paga os dois.
  → migration 005 + `VOCABULARIO_INTERNO` + `db/verificar-vocabulario.js`.
- `lerJson` ligava o flag `encerrado` antes de chamar a função que checa
  esse flag. A Promise nunca resolvia e a requisição ficava pendurada até
  o cliente desistir — sem mensagem, sem log. Agora é um ponto único de
  decisão (`liquidar`). → `test/http.test.js`.
- `config.validarConfig()` foi chamado como se fosse método do objeto
  `config`; é função exportada. Só apareceu rodando o `src/server.js` de
  verdade — nenhum teste importava esse arquivo.
- O health check vivia fora do roteador e respondia 200 em POST, enquanto
  toda rota devolve 405. Só apareceu testando método por método.
- **`JA_ESTAVA_PAGA` retornava `duplicado: false`** quando chegava evento
  novo para pagamento já processado. O front usava `duplicado` pra avisar
  "já estava baixa" e não mostrava a mensagem. Corrigido em
  `src/servicos/baixaPix.js:140` para retornar `duplicado: true` quando
  `acao === 'JA_ESTAVA_PAGA'`.

## Pendente

- **Autenticação de usuário.** O painel está aberto para quem souber a
  porta. Não expor na internet sem colocar pelo menos uma senha na frente.
- **Asaas real.** O código está escrito e o modo simulado cobre o fluxo,
  mas nunca rodou contra a API real. `ASAAS_ACCESS_TOKEN` não existe nesta
  máquina. O que pode dar errado e que ninguém achou: formato exato do
  `pixQrCode.responseWithQrCode`, `endDate` do Asaas recusando data, e
  `POST /v3/customers` exigindo `cpfCnpj` que aqui não é obrigatório.
- **Carteira.** Ligar cliente ao `id_cliente_gateway` e mostrar saldo.