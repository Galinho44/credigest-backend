import { config, validarConfig } from './config.js';
import { logger } from './logger.js';
import { conectar } from './banco/conexao.js';
import { migrar } from './banco/migrar.js';
import { criarAplicacao } from './app.js';

/**
 * Ponto de entrada do servidor.
 *
 * Ordem das operacoes nao e' arbitraria:
 *  1. valida configuracao  -> se o .env esta errado, melhor falhar agora
 *                            do que aceitar requisicao e quebrar depois
 *  2. roda migrations      -> o banco precisa existir antes de atender
 *  3. abre conexao         -> o restante do codigo assume banco pronto
 *  4. sobe o HTTP          -> so agora aceita requisicao
 *
 * Se inverter, a primeira requisicao batendo num banco sem tabela da
 * 500 no meio de uso real.
 */
async function principal() {
  validarConfig();

  // `migrar()` e' sincrono e ja abre a conexao sozinho (le o caminho do
  // .env). Passar um objeto de conexao aqui quebraria: ele seria
  // tratado como caminho de arquivo.
  const resultado = migrar();
  if (resultado.alteradas.length > 0) {
    logger.warn('ha migrations alteradas depois de aplicadas', {
      migrations: resultado.alteradas,
      aviso: 'crie uma migration nova em vez de editar uma que ja rodou',
    });
  }

  const conexao = conectar();

  if (config.webhook.token) {
    logger.info('webhook pronto', {
      caminho: '/api/webhooks/pix',
      token: 'configurado',
    });
  } else {
    logger.warn('webhook SEM token: qualquer POST em /api/webhooks/pix sera recusado', {
      dica: 'defina ASAAS_WEBHOOK_TOKEN no .env',
    });
  }

  const servidor = criarAplicacao();

  try {
    await new Promise((resolve, reject) => {
      servidor.once('error', reject);
      servidor.listen(config.porta, config.host, resolve);
    });
  } catch (erro) {
    // Sem este `try`, `EADDRINUSE` cai no handler de 'error' nao tratado
    // do EventEmitter e o Node imprime a stack crua:
    //
    //     Error: listen EADDRINUSE: address already in use 127.0.0.1:3000
    //         at Server.setupListenHandle ...
    //     Emitted 'error' event on Server instance at:
    //         emitErrorNT (node:events:505)
    //
    // Isso aparece numa segunda `npm start` esquecida — a situaçao mais
    // comum de todo dia de uso. A causa real ("ya tem um servidor nessa
    // porta") fica enterrada em 6 linhas de stack do modulo `net`, e o
    // usuario novo conclui que o projeto esta quebrado.
    if (erro.code === 'EADDRINUSE') {
      logger.error('porta ocupada', {
        porta: config.porta,
        causa: 'outro processo ja esta escutando nessa porta',
        resolver:
          'feche o outro servidor, ou mude a porta no .env (PORTA=3001). ' +
          'Para achar o processo: Get-NetTCPConnection -LocalPort ' +
          config.porta + ' -State Listen',
      });
      process.exit(1);
    }
    throw erro;
  }

  const endereco = `http://${config.host}:${config.porta}`;
  logger.info('Credigest no ar', {
    painel: endereco,
    api: `${endereco}/api`,
    gateway: config.gateway.nome,
    banco: config.caminhoBancoAbsoluto,
    ambiente: config.ambiente,
  });

  // Encerramento gracioso: o Ctrl+C deve fechar conexao e socket.
  // Sem isso, o SQLite fica com o arquivo travado ate o SO decidir matar.
  let encerrando = false;
  const encerrar = (sinal) => {
    if (encerrando) return;
    encerrando = true;
    logger.info('encerrando', { sinal });

    servidor.close(() => {
      try {
        conexao.fechar();
      } catch (erro) {
        logger.error('erro fechando banco', { erro: erro.message });
      }
      process.exit(0);
    });

    // Se alguma conexao ficar pendurada, nao espera para sempre.
    setTimeout(() => {
      logger.warn('forcando encerramento apos 5s');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

principal().catch((erro) => {
  logger.error('nao consegui subir o servidor', { erro: erro.message, stack: erro.stack });
  process.exit(1);
});