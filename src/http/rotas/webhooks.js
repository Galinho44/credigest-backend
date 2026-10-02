import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { compararToken } from '../middlewares/index.js';
import { processarEvento, conferirDivergencia } from '../../servicos/baixaPix.js';
import * as eventosRepo from '../../dominio/repositorios/eventosWebhook.js';
import { ErroDeAutenticacao, ErroDeNegocio, ErroDeValidacao } from '../../utilitarios/erros.js';

/**
 * Endpoint de webhook: POST /api/webhooks/pix
 *
 * ============================================================
 *  ESTA ROTA DECIDE QUE DINHEIRO ENTROU. LEIA COM ATENCAO.
 * ============================================================
 *
 * Se alguem descobrir esta URL e conseguir mandar um POST com
 * {"event":"PAYMENT_RECEIVED"}, toda divida pendente da Credigest
 * vira paga. Ninguem ganhou nada, o preco foi silenciosamente apagado.
 * Por isso a validacao acontece ANTES de qualquer leitura ou escrita:
 *
 *  1. Header `asaas-access-token` tem que bater com o token
 *     configurado, comparado em tempo constante.
 *  2. Se nao bater -> 401 e NAO se diz qual parte estava errada.
 *
 * Endurecimento extra recomendado para producao (fora do codigo, na
 * infra): restringir o endpoint aos IPs oficiais do Asaas no firewall.
 * O token sozinho ja resolve, e' a segunda camada.
 *
 * -----------------------------------------
 *  POR QUE SEMPRE RESPONDER 200
 * -----------------------------------------
 * O gateway so considera sucesso em 2xx. Se a baixa deu certo mas a
 * resposta foi perdida na volta, ele reenvia. Se nesse reenvio
 * respondessemos 500 por causa de um erro interno, ele reenviaria
 * varias vezes e o problema viraria uma tempestade de webhook.
 *
 * Entao: evento mal formado (400 e pro gateway parar de tentar) versus
 * evento valido que deu erro interno (200 + log, porque repetir faz
 * sentido). Error do cliente e' 4xx; erro nosso e' 200 com log.
 */
export function registrar(rota) {
  rota.post('/api/webhooks/pix', (req, res) => {
    // ---------- 1. Autenticacao (antes de qualquer coisa) ----------
    const recebido = req.headers['asaas-access-token'];

    if (!config.webhook.token) {
      // So acontece com GATEWAY=asaas e .env sem token, mas o
      // validarConfig() impede subir assim. Se chegar aqui, e' porque
      // alguem trocou o gateway em runtime: recusa e avisa.
      logger.error('webhook recebido mas ASAAS_WEBHOOK_TOKEN nao esta configurado');
      throw new ErroDeAutenticacao('webhook desabilitado: token nao configurado no servidor');
    }

    if (!compararToken(recebido, config.webhook.token)) {
      logger.warn('webhook recusado por token invalido', {
        origem: req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? null,
        recebeu_header: Boolean(recebido),
      });
      // Mensagem generica de proposito: nao diz se o header faltou ou
      // estava errado, senao vira oraculo para quem esta testando token.
      throw new ErroDeAutenticacao('token invalido');
    }

    // ---------- 2. Processa ----------
    let resultado;
    try {
      resultado = processarEvento(req.corpo);
    } catch (erro) {
      if (erro instanceof ErroDeValidacao) {
        // Payload invalido: reenviar nao vai consertar. 4xx faz o
        // gateway desistir e mostrar o evento como falho no painel dele,
        // que e' exatamente o que o operador precisa ver.
        logger.error('payload de webhook invalido', { erro: erro.message });
        res.status(400).json({ erro: { codigo: erro.codigo, mensagem: erro.message } });
        return;
      }

      if (erro instanceof ErroDeNegocio && erro.status === 404) {
        // Evento de verdade sobre pagamento que a Credigest nao
        // conhece. Pode ser cobranca de outro sistema usando a mesma
        // conta. Nao e' erro: responde 200 para nao gerar retentativa.
        logger.warn('webhook sobre pagamento desconhecido', {
          id_evento: req.corpo?.id ?? null,
          evento: req.corpo?.event ?? null,
        });
        res.status(200).json({ recebido: true, resultado: 'PAGAMENTO_DESCONHECIDO' });
        return;
      }

      // Erro nosso (banco fora, bug). Responde 200 para o gateway
      // parar de tentar agora, mas fica registrado que nao processou.
      // Se este evento voltar, o painel mostra a fila.
      logger.error('erro interno processando webhook; registrado como nao processado', {
        id_evento: req.corpo?.id ?? null,
        erro: erro.message,
        stack: erro.stack,
      });

      // Libera o evento: se o gateway reenviar, ele precisa poder
      // ser processado de novo.
      if (req.corpo?.id) {
        try {
          eventosRepo.liberarParaReprocessamento(req.corpo.id);
        } catch (e) {
          logger.error('nao consegui liberar evento para reprocessamento', { erro: e.message });
        }
      }

      res.status(200).json({ recebido: true, resultado: 'ERRO_INTERNO_REGISTRADO' });
      return;
    }

    // ---------- 3. Confere se o valor pago bate com o cobrado ----------
    const divergencia = resultado.cobranca ? conferirDivergencia(resultado.cobranca) : null;

    res.status(200).json({
      recebido: true,
      duplicado: resultado.duplicado,
      evento: resultado.evento,
      resultado: resultado.resultado,
      mensagem: resultado.mensagem,
      ...(divergencia ? { atencao: divergencia } : {}),
    });
  });
}