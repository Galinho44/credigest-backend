import * as servico from '../../servicos/cobrancaPix.js';
import * as whatsapp from '../../servicos/whatsapp.js';
import * as baixaPix from '../../servicos/baixaPix.js';
import * as simulado from '../../gateways/simulado.js';
import { gateway } from '../../gateways/index.js';
import { exigir, idInteiro, filtrosDeListagem, dataOpcional } from './validacao.js';
import { ErroDeNegocio } from '../../utilitarios/erros.js';

/**
 * Rotas de cobranca Pix.
 *
 *   GET  /api/cobrancas                 lista
 *   GET  /api/cobrancas/:id             detalhe
 *   POST /api/cobrancas                 gera Pix  <- FUNCIONALIDADE 1.1
 *   GET  /api/cobrancas/:id/whatsapp    link wa.me <- FUNCIONALIDADE 2
 *   POST /api/cobrancas/:id/simular-pagamento  (so no gateway simulado)
 */
export function registrar(rota) {
  rota.get('/api/cobrancas', (req, res) => {
    const { limite, offset } = filtrosDeListagem(req.query);
    const filtros = { limite, offset };
    if (req.query.cliente_id) filtros.cliente_id = idInteiro(req.query.cliente_id, 'cliente_id');
    if (req.query.status) filtros.status = String(req.query.status).toUpperCase();
    res.json({ dados: servico.listar(filtros) });
  });

  rota.get('/api/cobrancas/:id', (req, res) => {
    res.json({ dados: servico.detalhar(idInteiro(req.params.id, 'id')) });
  });

  // ---------------------------------------------------------------
  // FUNCIONALIDADE 1 - Gerar cobranca Pix
  // ---------------------------------------------------------------
  rota.post('/api/cobrancas', async (req, res) => {
    const corpo = exigir(req.corpo, ['cliente_id']);
    const clienteId = idInteiro(corpo.cliente_id, 'cliente_id');

    const { cobranca, reutilizada } = await servico.gerarCobrancaPix({
      cliente_id: clienteId,
      divida_id: corpo.divida_id !== undefined ? idInteiro(corpo.divida_id, 'divida_id') : null,
      valor: corpo.valor ?? null,
      vencimento: dataOpcional(corpo.vencimento, 'vencimento'),
    });

    // 201 quando criou algo novo; 200 quando reaproveitou um Pix já
    // emitido. A diferença importa para quem chama.
    res.status(reutilizada ? 200 : 201).json({
      dados: {
        ...cobranca,
        // O que o frontend precisa para pintar a tela.
        pix: {
          copia_e_cola: cobranca.pix_copia_e_cola,
          qr_code_url: cobranca.qr_code_url,
        },
      },
      meta: { reutilizada },
    });
  });

  // ---------------------------------------------------------------
  // FUNCIONALIDADE 2 - WhatsApp
  // ---------------------------------------------------------------
  //
  // Retorna os dados prontos: numero formatado, texto e o link wa.me.
  // O frontend so precisa abrir a URL. Montar a mensagem no browser
  // espalharia a regra de negocio (valor em BRL, DDD, texto) por um
  // arquivo de JS que ninguem versiona junto com a API.
  rota.get('/api/cobrancas/:id/whatsapp', (req, res) => {
    const cobranca = servico.detalhar(idInteiro(req.params.id, 'id'));

    const pacote = whatsapp.prepararCobranca({
      cliente: {
        nome: cobranca.cliente_nome,
        ddd: cobranca.cliente_ddd,
        telefone: cobranca.cliente_telefone,
      },
      cobranca,
    });

    res.json({ dados: pacote });
  });

  // ---------------------------------------------------------------
  // Ajuda de teste: baixa manual no gateway simulado
  // ---------------------------------------------------------------
  //
  // Existe para poder demonstrar o fluxo inteiro sem banco de verdade.
  // Em GATEWAY=asaas ela responde 404 de proposito: nao existe "simular
  // pagamento" num gateway real, quem paga e o cliente.
  //
  // ATENCAO — por que isto NAO' chama POST /api/webhooks/pix:
  // a rota do webhook exige o token, e o painel nao tem (e nao deve ter)
  // esse token no navegador. Expor o segredo do webhook para o cliente
  // seria transformar "so o Asaas baixa divida" em "qualquer pessoa com
  // o devtools aberto baixa divida".
  //
  // Entao a chamada vai DIRETO para o mesmo `processarEvento` que o
  // webhook usa. A logica de negocio exercitada e' identica: mesma
  // transacao, mesma idempotencia, mesma checagem de divergencia. O que
  // nao e' exercitado aqui e' a autenticacao — e isso e' proposital,
  // porque token de webhook se testa no teste do webhook.
  rota.post('/api/cobrancas/:id/simular-pagamento', (req, res) => {
    if (gateway().nome !== 'simulado') {
      throw new ErroDeNegocio('simulacao so existe no gateway simulado', {
        status: 404,
        codigo: 'SIMULACAO_INDISPONIVEL',
      });
    }

    const cobranca = servico.detalhar(idInteiro(req.params.id, 'id'));

    const evento = simulado.montarEventoPagamento({
      idCobranca: cobranca.id_transacao_gateway,
      status: 'RECEIVED',
      valor: cobranca.valor_centavos / 100,
    });

    const resultado = baixaPix.processarEvento(evento);
    const divergencia = resultado.cobranca ? baixaPix.conferirDivergencia(resultado.cobranca) : null;

    res.json({
      dados: {
        evento,
        resultado: resultado.resultado,
        duplicado: resultado.duplicado,
        cobranca: resultado.cobranca,
        ...(divergencia ? { atencao: divergencia } : {}),
      },
    });
  });
}