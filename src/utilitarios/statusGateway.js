/**
 * Vocabulário de status do gateway.
 *
 * Por que este arquivo existe — bug real, encontrado pelos testes:
 * o Asaas devolve `PENDING` / `RECEIVED` / `CONFIRMED` (inglês). O
 * gateway simulado devolvia a mesma coisa. Mas o banco, as views e as
 * migrações falam `PENDENTE` (português).
 *
 * O efeito era silencioso e grave: o índice único "no máximo um Pix
 * pendente por dívida" filtra `status_gateway = 'PENDENTE'`. Com
 * 'PENDING' gravado, essa condição nunca era verdadeira e o índice
 * nunca protegia nada. Duas chamadas simultâneas criavam dois Pix para
 * a mesma dívida, e o cliente podia pagar os dois.
 *
 * A regra passa a ser: o gateway fala a língua dele, o banco fala a
 * nossa, e a tradução acontece NESTE arquivo. Ninguém mais deve gravar
 * string de status direto no banco.
 */

/** Status do gateway (inglês) -> status interno (português). */
const DE_GATEWAY = {
  PENDING: 'PENDENTE',
  RECEIVED: 'RECEBIDO',
  CONFIRMED: 'CONFIRMADO',
  APPROVED: 'APROVADO',
  PROCESSING: 'PROCESSANDO',
  CANCELLED: 'CANCELADO',
  CANCELED: 'CANCELADO',
  DELETED: 'EXCLUIDO',
  EXPIRED: 'EXPIRADO',
  FAILED: 'FALHOU',
  REFUNDED: 'ESTORNADO',
  CHARGEBACK: 'ESTORNADO',
};

/** Status interno -> o que o painel mostra. */
const ROTULOS = {
  PENDENTE: 'Aguardando pagamento',
  RECEBIDO: 'Recebido (em análise)',
  CONFIRMADO: 'Confirmado',
  APROVADO: 'Aprovado',
  PROCESSANDO: 'Processando',
  CANCELADO: 'Cancelado',
  EXCLUIDO: 'Excluído',
  EXPIRADO: 'Expirado',
  FALHOU: 'Falhou',
  ESTORNADO: 'Estornado',
};

/** Status que NÃO está mais em aberto: pode gerar Pix novo para a dívida. */
const FECHADOS = new Set(['CANCELADO', 'EXCLUIDO', 'EXPIRADO', 'FALHOU', 'ESTORNADO']);

/**
 * Todo status interno que este módulo reconhece, em ordem de leitura:
 * em aberto, recebido, fechado, indefinido.
 *
 * EXPORTADO de propósito. A migration `005_normalizar_status_gateway.sql`
 * precisa da MESMA lista em SQL, e duas listas escritas à mão divergem em
 * silêncio — foi assim que a primeira versão da 005 ficou com
 * `REEMBOLSADO` (que não existe aqui) e sem cobrir `EXCLUIDO`/`APROVADO`/
 * `PROCESSANDO`, o que faria o UPDATE defensivo abrir um Pix numa
 * cobrança estornada.
 *
 * `db/verificar-vocabulario.js` usa este array para conferir a migration
 * contra o código. Ao adicionar um status em `DE_GATEWAY`, some com ele
 * também aqui — o verificador avisa se a migration ficou para trás.
 *
 * @type {readonly string[]}
 */
export const VOCABULARIO_INTERNO = Object.freeze([
  // ainda pode receber pagamento
  'PENDENTE',
  'APROVADO',
  'PROCESSANDO',
  // dinheiro entrou
  'RECEBIDO',
  'CONFIRMADO',
  // não está mais em aberto
  'CANCELADO',
  'EXCLUIDO',
  'EXPIRADO',
  'FALHOU',
  'ESTORNADO',
  // indefinido: o gateway mandou algo que a gente não conhece
  'DESCONHECIDO',
]);

/**
 * Traduz o status do gateway para o vocabulário interno.
 *
 * Status desconhecido NÃO vira 'PENDENTE' às cegas: seria inventar
 * verdade. Vira 'DESCONHECIDO', que não casa com nenhum índice nem
 * aparece como pendente, e a fila de conciliação mostra para o operador
 * decidir.
 *
 * @param {string|null|undefined} status
 * @returns {string|null}
 */
export function normalizarStatusGateway(status) {
  if (status === null || status === undefined || status === '') return null;
  const chave = String(status).trim().toUpperCase();
  return DE_GATEWAY[chave] ?? 'DESCONHECIDO';
}

/** Rótulo legível para a interface. */
export function rotularStatus(status) {
  if (!status) return '—';
  return ROTULOS[status] ?? status;
}

/** O status já não está em aberto? */
export function estaFechado(status) {
  return FECHADOS.has(status);
}

/** Ainda pode receber pagamento? */
export function estaEmAberto(status) {
  return status === 'PENDENTE' || status === 'RECEBIDO' || status === 'CONFIRMADO'
    || status === 'APROVADO' || status === 'PROCESSANDO';
}