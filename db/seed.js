/**
 * Popula o banco com dados de demonstracao.
 *
 *   node --env-file-if-exists=.env db/seed.js
 *
 * Por que existe: um banco vazio nao mostra bug. As views de total, o
 * agrupamento de pendente/pago e o calculo de saldo so tem chance de
 * falhar com dados parecidos com os reais. Esse script cria dividas
 * pagas, pendentes e vencidas, para o painel aparecer com a realidade
 * de uma loja de verdade.
 *
 * REGRA INEGOCIAVEL: so roda se o banco estiver vazio. Nunca apaga dado,
 * nunca faz UPDATE em divida que o usuario criou.
 */
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { conectar } from '../src/banco/conexao.js';
import { migrar } from '../src/banco/migrar.js';
import * as clientesRepo from '../src/dominio/repositorios/clientes.js';
import * as dividasRepo from '../src/dominio/repositorios/dividas.js';
import * as cobrancasRepo from '../src/dominio/repositorios/cobrancas.js';
import { simulado } from '../src/gateways/index.js';
import { processarEvento } from '../src/servicos/baixaPix.js';
import { paraCentavos } from '../src/utilitarios/dinheiro.js';

const CLIENTES = [
  { nome: 'Maria Aparecida Souza', ddd: '11', telefone: '987654321', email: 'maria.souza@exemplo.com' },
  { nome: 'Joao Pedro Lima', ddd: '21', telefone: '998877665', email: null },
  { nome: 'Ana Carolina Ferreira', ddd: '31', telefone: '988776655', email: 'ana.ferreira@exemplo.com' },
  { nome: 'Carlos Eduardo Mendes', ddd: '48', telefone: '998877554', email: null },
];

const DIVIDAS = [
  { indice: 0, descricao: 'Parcela 3/12 - Servico completo', valor: '850.00', estado: 'paga' },
  { indice: 0, descricao: 'Parcela 4/12 - Servico completo', valor: '850.00', estado: 'pendente' },
  { indice: 1, descricao: 'Manutencao preventiva de equipamento', valor: '420.50', estado: 'pendente' },
  { indice: 2, descricao: 'Consultoria - Projeto Aurora', valor: '1200.00', estado: 'paga' },
  { indice: 3, descricao: 'Parcela 1/3 - Formacao', valor: '670.00', estado: 'pendente' },
];

function jaTemDados() {
  return dividasRepo.listar({ limite: 1 }).length > 0;
}

function principal() {
  migrar();

  if (jaTemDados()) {
    logger.warn('banco ja tem dados: seed cancelado (nada foi apagado)', {
      exemplo_de_divida: dividasRepo.listar({ limite: 1 })[0],
    });
    return;
  }

  const criados = CLIENTES.map((dados) => {
    const cliente = clientesRepo.criar(dados);
    logger.info('cliente criado', { id: cliente.id, nome: cliente.nome });
    return cliente;
  });

  for (const item of DIVIDAS) {
    const cliente = criados[item.indice];
    const valorCentavos = paraCentavos(item.valor);

    const divida = dividasRepo.criar({
      cliente_id: cliente.id,
      descricao: item.descricao,
      valor_centavos: valorCentavos,
      vencimento: null,
    });

    // Usa o MESMO caminho do servico real: gateway -> INSERT local ->
    // UPDATE com id e pix. Se o seed fizesse atalho, ele nao estaria
    // testando o caminho que roda em producao.
    const pix = simulado.criarCobrancaPix({
      valorCentavos,
      descricao: item.descricao,
      referencia: `divida:${divida.id}`,
      cliente,
    });

    const cobranca = cobrancasRepo.criar({
      divida_id: divida.id,
      cliente_id: cliente.id,
      gateway: simulado.nome,
      id_transacao_gateway: pix.id,
      valor_centavos: valorCentavos,
      pix_copia_e_cola: pix.copiaECola,
      qr_code_url: pix.qrCodeUrl ?? null,
      status_gateway: pix.status ?? 'PENDENTE',
    });

    if (item.estado === 'paga') {
      // Passa pelo mesmo caminho do webhook: assim o seed exercita o
      // fluxo real em vez de escrever direto na tabela.
      processarEvento(
        simulado.montarEventoPagamento({
          idCobranca: pix.id,
          status: 'RECEIVED',
          valor: valorCentavos / 100,
        })
      );
      logger.info('divida paga', { id: divida.id, descricao: item.descricao });
    } else {
      logger.info('divida pendente', { id: divida.id, descricao: item.descricao, cobranca: cobranca.id });
    }
  }

  logger.info('seed concluido', {
    clientes: CLIENTES.length,
    dividas: DIVIDAS.length,
    resumo: dividasRepo.resumo(),
  });
}

try {
  principal();
} catch (erro) {
  logger.error('seed falhou', { erro: erro.message, stack: erro.stack });
  process.exitCode = 1;
} finally {
  conectar().fechar();
}