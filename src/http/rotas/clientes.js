import * as repo from '../../dominio/repositorios/clientes.js';
import * as dividasRepo from '../../dominio/repositorios/dividas.js';
import { exigir, textoObrigatorio, emailOpcional, idInteiro, filtrosDeListagem } from './validacao.js';

/**
 * Rotas de clientes.
 *
 *   GET    /api/clientes         lista
 *   GET    /api/clientes/:id     um cliente
 *   POST   /api/clientes         cria
 *   PUT    /api/clientes/:id     atualiza
 *   DELETE /api/clientes/:id     remove (so se nao tiver movimento)
 */
export function registrar(rota) {
  rota.get('/api/clientes', (req, res) => {
    const { limite, offset } = filtrosDeListagem(req.query);
    res.json({ dados: repo.listar({ limite, offset }) });
  });

  rota.get('/api/clientes/:id', (req, res) => {
    const id = idInteiro(req.params.id, 'id');
    res.json({ dados: repo.buscarPorId(id) });
  });

  rota.post('/api/clientes', (req, res) => {
    const corpo = exigir(req.corpo, ['nome', 'ddd', 'telefone']);

    const cliente = repo.criar({
      nome: textoObrigatorio(corpo.nome, 'nome', { min: 2 }),
      ddd: corpo.ddd,
      telefone: corpo.telefone,
      email: emailOpcional(corpo.email),
      documento: corpo.documento ?? null,
    });

    res.status(201).json({ dados: cliente });
  });

  rota.put('/api/clientes/:id', (req, res) => {
    const id = idInteiro(req.params.id, 'id');
    const corpo = exigir(req.corpo, []);

    const cliente = repo.atualizar(id, {
      nome: corpo.nome !== undefined ? textoObrigatorio(corpo.nome, 'nome', { min: 2 }) : undefined,
      email: corpo.email !== undefined ? emailOpcional(corpo.email) : undefined,
      ddd: corpo.ddd,
      telefone: corpo.telefone,
      documento: corpo.documento,
    });

    res.json({ dados: cliente });
  });

  rota.delete('/api/clientes/:id', (req, res) => {
    const id = idInteiro(req.params.id, 'id');
    res.json({ dados: repo.remover(id) });
  });

  // ---- resumo do painel ----
  rota.get('/api/painel/resumo', (_req, res) => {
    res.json({
      dados: {
        ...dividasRepo.resumo(),
        clientes: repo.listar({ limite: 200 }).length,
      },
    });
  });
}