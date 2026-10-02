# Credigest

Cobrança por Pix com baixa automática via webhook. Você cadastra o
cliente, gera o Pix, manda a cobrança no WhatsApp e a dívida se quita
 sozinha quando o pagamento cai.

Feito sem dependência de runtime: só Node.js e SQLite.

---

## Como rodar

```bash
npm run migrate    # cria/atualiza o banco
npm run seed       # dados de demonstração (só se o banco estiver vazio)
npm start          # sobe em http://127.0.0.1:3000
```

`npm run dev` recarrega sozinho a cada alteração.

**Requisito:** Node.js **22.5 ou superior**. O projeto usa
`node:sqlite`, que só existe a partir dessa versão, e
`--env-file-if-exists`, que também. Testado no 24.21.

## Testes

```bash
npm test                          # 72 testes
node db/verificar-vocabulario.js  # migration 005 x codigo
```

---

## Como funciona

```
cliente -> divida -> cobranca Pix -> WhatsApp
                              |
                              v
                    cliente paga o Pix
                              |
                              v
                    Asaas manda o webhook
                              |
                              v
                    divida vira PAGO
```

O painel é em `publico/`, servido pelo próprio Node. Não há build, não
há framework, não há `node_modules`.

### Os dois gateways

| | `GATEWAY=simulado` | `GATEWAY=asaas` |
|---|---|---|
| Gera Pix | sim, com cara de Pix | sim, via API do Asaas |
| Alguém consegue pagar | **não** | sim |
| Webhook | botão "simular" no painel | webhook real do Asaas |
| Serve para | desenvolver e testar | produzir |

No simulado ninguém paga: o Pix copia-e-cola tem a estrutura do EMV, mas
nenhum banco vai aceitar. Isso é proposital — escrever o fluxo inteiro
antes de ter conta no Asaas é a diferença entre uma tarde e uma semana.

Para usar o Asaas, ponha no `.env`:

```
GATEWAY=asaas
ASAAS_ACCESS_TOKEN=...
ASAAS_WEBHOOK_TOKEN=...
```

`ASAAS_WEBHOOK_TOKEN` é o token que o Asaas manda no header
`asaas-access-token`. **Os dois tokens são diferentes e não se
confundem.** Se você usar o token da API no webhook, qualquer pessoa
descobre o token da API.

---

## O dinheiro

**Dentro do sistema, dinheiro é inteiro em centavos.** `85000` é R$ 850,00.
Texto com vírgula só existe na borda HTTP.

Isso não é preciosismo de estilo. Havia um bug em que a mesma rota recebia
`850.00` do usuário, convertia para `85000`, e o repositório convertia de
novo — o cliente era cobrado R$ 850,00 e o sistema registrava R$ 85.000,00.
Ou o inverso. O número mudava de rosto conforme atravessava as camadas.

A regra: **converte na entrada, guarda centavos, formata na saída.**

Se o cliente pagar mais do que devia, o saldo vai a `0` e a diferença fica
visível no valor pago. Número negativo na tela vira "a Credigest deve
dinheiro ao cliente", que não é o que saldo significa.

---

## Webhook

```
POST /api/webhooks/pix
Header: asaas-access-token: <token do .env>
```

Três decisões que valem explicar:

**Token fora do navegador.** O painel não tem o token do webhook, e não
deve. Expor esse segredo no front seria transformar "só o Asaas baixa
dívida" em "qualquer pessoa com o devtools aberto baixa dívida". O botão
"simular pagamento" do painel chama o mesmo `processarEvento` por dentro,
sem passar pela autenticação — a lógica exercitada é a mesma.

**401 é sempre a mesma mensagem.** Header ausente, token errado e token
curto devolvem exatamente a mesma resposta. Se o servidor dissesse "token
muito curto", o atacante aprenderia o formato válido sem tentar nada.

**Erro nosso responde 200.** Se a Credigest está fora do ar, o Asaas
reenvia. Se a Credigest responde 500 num evento que já deu problema, o
Asaas reenvia em loop e isso vira tempestade. Evento malformado
responde 400 — aí o gateway para de tentar, que é o certo.

### Idempotência

O Asaas reenvia evento. O botão de simulação pode ser clicado duas vezes.
O webhook pode chegar em duplicata por retry de rede.

Duas camadas:

1. **`eventos_webhook.id_evento`** com índice único. O mesmo evento
   processado duas vezes devolve `200 { duplicado: true }`.
2. **`UPDATE cobrancas SET pago_em = ... WHERE id = ? AND pago_em IS NULL`**
   e, no mesmo passo, o evento é gravado. É transacional.

A segunda é a que importa. Mesmo que o mesmo pagamento chegue com dois
`id_evento` diferentes (o Asaas pode gerar evento novo para o mesmo
pagamento), o `WHERE pago_em IS NULL` garante que só um vai ser
creditado. A dívida é quitada uma vez só.

---

## Banco

Migrations em `db/migrations/`, aplicadas em ordem, com checksum.

**Migration aplicada não se edita.** O runner guarda o checksum e avisa se
o arquivo mudou. Isso não é implicância: é o que impede a classe de bug
mais chata que existe em migration — alguém "corrige" o arquivo, o banco
novo fica certo, o banco antigo continua errado, e ninguém entende por
que os dois sistemas se comportam diferente. Correção de dados entra
sempre como migration nova.

Duas migrations são bug corrigido, e os comentários explicam por quê:

- **`002`** — a `vw_dividas` somava cobrança pendente como se fosse paga.
  O painel mostrava "status: pendente" e "deve R$ 0,00" na mesma linha, e o
  total a receber do painel saía zerado.
- **`004`** — corrige a `002` e adiciona `descricao_divida` na
  `vw_cobrancas` (é o que a mensagem do WhatsApp mostra).
- **`005`** — normaliza `status_gateway` gravado em inglês por linhas
  antigas. Rodar `npm run migrate` num banco já existente precisa da 005
  senão a busca de "Pix em aberto" não acha nada.

---

## Endereços

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/saude` | vivo? qual gateway? |
| GET | `/api/painel/resumo` | totais da tela inicial |
| GET/POST | `/api/clientes` | lista / cria |
| GET | `/api/clientes/:id` | detalhe |
| GET/POST | `/api/dividas` | lista / cria |
| GET | `/api/dividas/:id` | detalhe |
| GET | `/api/dividas/:id/whatsapp` | atalho: monta a mensagem pela dívida |
| GET/POST | `/api/cobrancas` | lista / gera Pix |
| GET | `/api/cobrancas/:id` | detalhe |
| GET | `/api/cobrancas/:id/whatsapp` | link do WhatsApp |
| POST | `/api/cobrancas/:id/simular-pagamento` | só no simulado |
| POST | `/api/webhooks/pix` | baixa |

Não existe `DELETE /api/dividas/:id`. Dívida é registro financeiro:
errar e apagar não tem volta. Para não cobrar mais, o caminho é gerar
cobrança menor ou registrar o pagamento.

### Formato das respostas

Sucesso:

```json
{ "dados": { "...": "..." } }
```

Erro:

```json
{ "erro": { "codigo": "DIVIDA_JA_PAGA", "mensagem": "...", "detalhes": {} } }
```

Os status são distintos de propósito:

| Status | Quer dizer |
|---|---|
| 400 | JSON quebrado — nem deu para ler |
| 401 | token do webhook errado, ausente ou do tamanho errado |
| 404 | não existe |
| 405 | existe, mas não nesse método |
| 409 | existe, mas não pode agora (já paga, sem Pix gerado) |
| 413 | corpo grande demais |
| 415 | `Content-Type` não é `application/json` |
| 422 | o JSON era válido, o conteúdo é que não faz sentido |

A diferença entre 400 e 422 importa: 400 é problema de sintaxe, 422 é
negócio. O painel usa isso pra decidir se é erro de digitação ou erro de
regra.

---

## WhatsApp

O WhatsApp não tem API de mensagem avulsa. O que existe é o link
`wa.me`, que abre a conversa com o texto já escrito. O cliente só aperta
enviar.

O número vai no formato internacional (`55` + DDD + número), que é o único
que o `wa.me` aceita. Texto, número e valor são montados no servidor —
montar no browser espalheria a regra de negócio por um arquivo que não é
versionado junto com a API.

Cobrança já paga não gera link. Mandar "pague R$ 123,45" de algo já
quitado faz o cliente pagar duas vezes.

---

## Estrutura

```
src/
  app.js            monta o HTTP, junta tudo
  server.js         boot, migrations, encerramento
  config.js         .env
  banco/            conexao, runner de migrations
  dominio/          repositorios (SQL puro)
  gateways/         asaas.js, simulado.js
  servicos/         cobrancaPix, baixaPix, whatsapp
  http/             roteador, middlewares, rotas
  utilitarios/      dinheiro, telefone, erros, status
publico/            o painel (sem build)
test/               72 testes
db/migrations/      001 a 005
```

**`dominio/` é a parte que cobra dinheiro.** Ela só vê centavos, só vê
status interno em português, e não conhece HTTP nem gateway. As camadas de
fora traduzem na entrada e formatam na saída.

---

## Problemas conhecidos

- **Divergência de valor não bloqueia a baixa.** Se o gateway diz que
  recebeu R$ 150,00 numa cobrança de R$ 120,00, o sistema credita os
  R$ 120,00 e devolve um aviso no corpo da resposta (`divergencia`).
  Bloquear seria pior: o dinheiro já entrou, recusar o registro só faz o
  painel mostrar uma dívida que o cliente já quitou. O valor a mais fica
  visível no `valor_pago_centavos`.
- **`CARTEIRA`** — não implementado. Não existe coluna para isso no
  schema: o plano era ligar cada cliente ao seu `id` no Asaas
  (`id_cliente_gateway`, migration 003) e usar a carteira dele para
  mostrar saldo e extrato. Nada disso foi construído.
- **Sem autenticação de usuário.** O painel é aberto para quem souber a
  porta. É o que o escopo pedia. Não expor na internet sem colocar pelo
  menos uma senha na frente.
- **Uma dívida por cobrança.** Parcelamento é N cobranças de R$ 30, não
  uma cobrança de R$ 90 com 3 parcelas.