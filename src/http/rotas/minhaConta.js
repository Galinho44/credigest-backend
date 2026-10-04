import * as repo from '../../dominio/repositorios/contasBancarias.js';
import { exigir, textoObrigatorio, idInteiro } from './validacao.js';
import { autenticacao } from '../rotas/auth.js';

/**
 * Rotas de contas bancarias (chaves Pix do recebedor).
 *
 *   GET    /api/minha-conta/contas        lista
 *   GET    /api/minha-conta/contas/:id    uma conta
 *   POST   /api/minha-conta/contas        cria
 *   PUT    /api/minha-conta/contas/:id    atualiza
 *   DELETE /api/minha-conta/contas/:id    remove
 *   POST   /api/minha-conta/contas/:id/padrao  define como padrao
 */
export function registrar(rota) {
  // Todas as rotas exigem autenticacao
  rota.use('/api/minha-conta/*', autenticacao);

  rota.get('/api/minha-conta/contas', (req, res) => {
    const usuarioId = req.usuario?.id;
    if (!usuarioId) return res.status(401).json({ erro: { codigo: 'NAO_AUTENTICADO', mensagem: 'Usuario nao autenticado' } });
    res.json({ dados: repo.listar(usuarioId) });
  });

  rota.get('/api/minha-conta/contas/:id', (req, res) => {
    const usuarioId = req.usuario?.id;
    const id = idInteiro(req.params.id, 'id');
    res.json({ dados: repo.buscarPorId(usuarioId, id) });
  });

  rota.post('/api/minha-conta/contas', (req, res) => {
    const usuarioId = req.usuario?.id;
    if (!usuarioId) return res.status(401).json({ erro: { codigo: 'NAO_AUTENTICADO', mensagem: 'Usuario nao autenticado' } });

    const corpo = exigir(req.corpo, ['tipo_chave', 'chave_pix', 'nome_titular', 'banco']);
    const conta = repo.criar(usuarioId, {
      tipo_chave: textoObrigatorio(corpo.tipo_chave, 'tipo_chave'),
      chave_pix: textoObrigatorio(corpo.chave_pix, 'chave_pix'),
      nome_titular: textoObrigatorio(corpo.nome_titular, 'nome_titular'),
      banco: textoObrigatorio(corpo.banco, 'banco'),
      agencia: corpo.agencia ?? null,
      conta: corpo.conta ?? null,
      conta_dv: corpo.conta_dv ?? null,
      padrao: corpo.padrao === true,
    });

    res.status(201).json({ dados: conta });
  });

  rota.put('/api/minha-conta/contas/:id', (req, res) => {
    const usuarioId = req.usuario?.id;
    if (!usuarioId) return res.status(401).json({ erro: { codigo: 'NAO_AUTENTICADO', mensagem: 'Usuario nao autenticado' } });

    const id = idInteiro(req.params.id, 'id');
    const corpo = exigir(req.corpo, []);
    const conta = repo.atualizar(usuarioId, id, {
      tipo_chave: corpo.tipo_chave,
      chave_pix: corpo.chave_pix,
      nome_titular: corpo.nome_titular,
      banco: corpo.banco,
      agencia: corpo.agencia,
      conta: corpo.conta,
      conta_dv: corpo.conta_dv,
      padrao: corpo.padrao,
      ativa: corpo.ativa,
    });

    res.json({ dados: conta });
  });

  rota.delete('/api/minha-conta/contas/:id', (req, res) => {
    const usuarioId = req.usuario?.id;
    if (!usuarioId) return res.status(401).json({ erro: { codigo: 'NAO_AUTENTICADO', mensagem: 'Usuario nao autenticado' } });

    const id = idInteiro(req.params.id, 'id');
    res.json({ dados: repo.remover(usuarioId, id) });
  });

  rota.post('/api/minha-conta/contas/:id/padrao', (req, res) => {
    const usuarioId = req.usuario?.id;
    if (!usuarioId) return res.status(401).json({ erro: { codigo: 'NAO_AUTENTICADO', mensagem: 'Usuario nao autenticado' } });

    const id = idInteiro(req.params.id, 'id');
    const conta = repo.definirPadrao(usuarioId, id);
    res.json({ dados: conta });
  });
}