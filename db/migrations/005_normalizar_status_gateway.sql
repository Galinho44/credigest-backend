-- =====================================================================
-- Credigest - migration 005: normaliza status_gateway ja gravados
--
-- POR QUE ESTA MIGRATION EXISTE
--
-- O dominio passou a falar portugues (PENDENTE, RECEBIDO, CONFIRMADO) e a
-- traducao acontece na BORDA, em `src/utilitarios/statusGateway.js`: todo
-- status que SAI do gateway passa por la antes de ser gravado.
--
-- O problema: a traducao so vale para o que entra a partir de agora. As
-- linhas gravadas ANTES da troca ficaram com o valor cru do gateway em
-- ingles. Medido neste banco antes da migration:
--     PENDING   -> 3 cobrancas
--     RECEIVED  -> 2 cobrancas
--     RECEBIDO  -> 1 cobranca
-- Duas linguagens convivendo na mesma coluna. Qualquer consulta que
-- compare com 'PENDENTE' — como a busca do Pix em aberto que o painel
-- usa — deixa de achar as 3 cobrancas em ingles, e o usuario ve
-- "gerar Pix" numa divida que ja tem Pix emitido.
--
-- POR QUE UM UPDATE e NAO UM RECREATE
--
-- `cobrancas` guarda dinheiro real: id do gateway, copia-e-cola do Pix,
-- pago_em. Recriar a tabela perderia tudo e nao tem por que.
--
-- POR QUE NAO EDITEI A 002 NEM A 004
--
-- Ja foram aplicadas e o runner guarda checksum. Alterar arquivo aplicado
-- faz o sistema avisar e nao reaplicar — e a protecao contra migration
-- "corrigida" que so roda em banco novo, que e' exatamente a classe de
-- bug que a 004 documentou. Correcao de dado sempre entra como migration
-- nova.
--
-- ATENCAO — este arquivo ESPELHA o mapa DE_GATEWAY de
-- `src/utilitarios/statusGateway.js`. SQL nao importa JS, entao o
-- vocabulario fica duplicado aqui. Se voce adicionar um status naquele
-- arquivo, tem que adicionar aqui tambem — senao o UPDATE defensivo do
-- final quebra o dado. Isso e' tradeoff aceito: migration e' historico
-- congelado, e nao pode depender de arquivo que voce vai editar depois.
--
-- Idempotente: rodar duas vezes nao muda nada a segunda vez.
-- =====================================================================

-- ---- em aberto ------------------------------------------------------
UPDATE cobrancas SET status_gateway = 'PENDENTE'
 WHERE status_gateway = 'PENDING';

UPDATE cobrancas SET status_gateway = 'APROVADO'
 WHERE status_gateway = 'APPROVED';

UPDATE cobrancas SET status_gateway = 'PROCESSANDO'
 WHERE status_gateway = 'PROCESSING';

-- ---- dinheiro recebido ----------------------------------------------
-- RECEIVED e CONFIRMED viram RECEBIDO de proposito, e nao status
-- diferentes. Para o saldo da divida os dois significam "entrou"; a
-- distincao entre recebido e confirmado fica no `pago_em` e no
-- historico de eventos, nao no status da cobranca.
UPDATE cobrancas SET status_gateway = 'RECEBIDO'
 WHERE status_gateway IN ('RECEIVED', 'CONFIRMED');

-- ---- nao esta mais em aberto ----------------------------------------
UPDATE cobrancas SET status_gateway = 'CANCELADO'
 WHERE status_gateway IN ('CANCELLED', 'CANCELED');

UPDATE cobrancas SET status_gateway = 'EXCLUIDO'
 WHERE status_gateway = 'DELETED';

UPDATE cobrancas SET status_gateway = 'EXPIRADO'
 WHERE status_gateway = 'EXPIRED';

UPDATE cobrancas SET status_gateway = 'FALHOU'
 WHERE status_gateway = 'FAILED';

UPDATE cobrancas SET status_gateway = 'ESTORNADO'
 WHERE status_gateway IN ('REFUNDED', 'CHARGEBACK');

-- ---- defensivo ------------------------------------------------------
-- Status que sobrou em ingles e nao tem traducao acima. `normalizarStatusGateway`
-- nunca devolve status cru (desconhecido vira 'DESCONHECIDO'), mas o seed e
-- scripts antigos gravam direto e nao passam pela borda.
--
-- A lista abaixo tem que ser EXATAMENTE o vocabulario de
-- `statusGateway.js`. Qualquer status interno fora dela cai para
-- 'DESCONHECIDO' — que e' o estado conservador: nao casa com 'PENDENTE',
-- entao nao vira "Pix em aberto" por acidente, e a fila de conciliacao
-- mostra para o operador decidir o que fazer.
--
-- (Uma versao anterior desta migration tinha a lista errada e, por
-- coerencia, transformava EXCLUIDO/APROVADO/PROCESSANDO em PENDENTE —
-- ou seja, abria um Pix de uma cobranca estornada. A lista segue o
-- arquivo .js de proposito, e a verificacao e' `node db/verificar-vocabulario.js`.)
UPDATE cobrancas SET status_gateway = 'DESCONHECIDO'
 WHERE status_gateway IS NOT NULL
   AND status_gateway NOT IN (
       -- em aberto
       'PENDENTE', 'APROVADO', 'PROCESSANDO',
       -- recebido
       'RECEBIDO', 'CONFIRMADO',
       -- fechado
       'CANCELADO', 'EXCLUIDO', 'EXPIRADO', 'FALHOU', 'ESTORNADO',
       -- indefinido
       'DESCONHECIDO'
   );