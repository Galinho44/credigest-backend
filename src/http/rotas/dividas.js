import * as repo from '../../dominio/repositorios/dividas.js';
import * as clientesRepo from '../../dominio/repositorios/clientes.js';
import * as cobrancasRepo from '../../dominio/repositorios/cobrancas.js';
import * as whatsapp from '../../servicos/whatsapp.js';
import { ErroDeNegocio } from '../../utilitarios/erros.js';
import { exigir, textoObrigatorio, dataOpcional, idInteiro, filtrosDeListagem, paraCentavos } from './validacao.js';

/**
 * Rotas de dividas.
 *
 *   GET  /api/dividas            lista (pode filtrar por ?status=)
 *   GET  /api/dividas/:id        uma divida
 *   POST /api/dividas            cria
 *
 * Nao existe DELETE /api/dividas/:id de proposito: divida e registro
 * financeiro. Errar e apagar divida e' o tipo de coisa que nao se
 * desfaz. Para nao cobrar mais, o caminho e gerar uma cobranca com
 * valor menor, ou registrar o pagamento - nao apagar o registro.
 */
export function registrar(rota) {
  rota.get('/api/dividas', (req, res) => {
    const { limite, offset } = filtrosDeListagem(req.query);

    const filtros = { limite, offset };
    if (req.query.cliente_id) filtros.cliente_id = idInteiro(req.query.cliente_id, 'cliente_id');
    if (req.query.status) filtros.status = String(req.query.status).toUpperCase();

    res.json({ dados: repo.listar(filtros) });
  });

  rota.get('/api/dividas/:id', (req, res) => {
    res.json({ dados: repo.buscarPorId(idInteiro(req.params.id, 'id')) });
  });

  /**
   * FUNCIONALIDADE 2 (atalho) — monta a mensagem direto a partir da divida.
   *
   * Existe por causa do botao na lista do painel: ali o usuario ve a
   * divida, nao a cobranca. Sem esta rota o painel teria que primeiro
   * descobrir qual cobranca esta em aberto, e a montagem da mensagem
   * ficaria dependente de o front saber disso.
   *
   * Se nao houver Pix em aberto, devolve 409 com o motivo — nao inventa
   * um Pix nem um link quebrado.
   */
  rota.get('/api/dividas/:id/whatsapp', (req, res) => {
    const divida = repo.buscarPorId(idInteiro(req.params.id, 'id'));

    // A divida quitada e' o primeiro caso, e nao o segundo, por um motivo
    // de mensagem: depois da baixa a busca por "Pix em aberto" volta
    // vazia (a cobranca ja nao esta mais em aberto), e o 409 cairia em
    // "gere o Pix primeiro". Isso e' mentira — o Pix foi gerado e pago.
    // O painel mostraria "gere o Pix" para uma divida que ja foi
    // quitada, e o usuario clicaria sem entender nada.
    if (divida.pago_em) {
      throw new ErroDeNegocio(`divida ${divida.id} ja foi paga. nao ha nada a cobrar.`, {
        status: 409,
        codigo: 'COBRANCA_JA_PAGA',
      });
    }

    const cobranca = cobrancasRepo.buscarPixPendenteDaDivida(divida.id);

    if (!cobranca) {
      throw new ErroDeNegocio(
        `divida ${divida.id} nao tem Pix em aberto para enviar. gere o Pix primeiro.`,
        { status: 409, codigo: 'PIX_NAO_GERADO' }
      );
    }

    res.json({
      dados: whatsapp.prepararCobranca({
        cliente: {
          nome: cobranca.cliente_nome,
          ddd: cobranca.cliente_ddd,
          telefone: cobranca.cliente_telefone,
        },
        cobranca,
      }),
    });
  });

  rota.post('/api/dividas', (req, res) => {
    const corpo = exigir(req.corpo, ['cliente_id', 'descricao', 'valor']);
    clientesRepo.buscarPorId(idInteiro(corpo.cliente_id, 'cliente_id'));

    const divida = repo.criar({
      cliente_id: idInteiro(corpo.cliente_id, 'cliente_id'),
      descricao: textoObrigatorio(corpo.descricao, 'descricao', { min: 3, max: 200 }),
      // A rota e a BORDA: o usuario manda "850.00" em reais e o dominio
      // recebe 85000 em centavos. `valor_centavos` nao e aceito aqui de
      // proposito — se aceitasse, o mesmo campo teria dois formatos
      // dependendo de quem mandou, e o bug da multiplicacao por 100
      // voltaria.
      valor_centavos: paraCentavos(corpo.valor),
      vencimento: dataOpcional(corpo.vencimento, 'vencimento'),
    });

    res.status(201).json({ dados: divida });
  });
}