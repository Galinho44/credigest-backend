import * as repo from '../../dominio/repositorios/clientes.js';
import * as dividasRepo from '../../dominio/repositorios/dividas.js';
import { exigir, textoObrigatorio, emailOpcional, idInteiro, filtrosDeListagem } from './validacao.js';
import { ErroDeConflito } from '../../utilitarios/erros.js';
import { buscarPorDocumento } from '../../dominio/repositorios/clientes.js';

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

function extrairDDDETelefone(corpo) {
    let ddd, telefone;
    if (corpo.telefone !== undefined && corpo.telefone !== null && String(corpo.telefone).trim() !== '') {
      const apenasDigitos = String(corpo.telefone).replace(/\D/g, '');
      if (apenasDigitos.length >= 10) {
        ddd = apenasDigitos.slice(0, 2);
        telefone = apenasDigitos.slice(2);
      }
    }
    if (corpo.ddd !== undefined && corpo.telefone !== undefined) {
      ddd = String(corpo.ddd).replace(/\D/g, '');
      telefone = String(corpo.telefone).replace(/\D/g, '');
    }
    return { ddd: ddd ?? '71', telefone: telefone ?? '999999999' };
  }

  rota.post('/api/clientes', (req, res) => {
    const corpo = exigir(req.corpo, ['nome']);
    const { ddd, telefone } = extrairDDDETelefone(corpo);

    const cliente = repo.criar({
      nome: textoObrigatorio(corpo.nome, 'nome', { min: 2 }),
      ddd,
      telefone,
      email: emailOpcional(corpo.email),
      documento: corpo.documento ?? null,
    });

    res.status(201).json({ dados: cliente });
  });

  // POST /api/clientes/buscar-ou-criar - evita duplicata
  rota.post('/api/clientes/buscar-ou-criar', (req, res) => {
    const corpo = exigir(req.corpo, ['nome']);
    const { ddd, telefone } = extrairDDDETelefone(corpo);

    // Tenta buscar por documento primeiro (mais confiavel)
    if (corpo.documento) {
      const existente = buscarPorDocumento(corpo.documento);
      if (existente) {
        // Atualiza dados basicos se mudaram
        return res.json({
          dados: repo.atualizar(existente.id, {
            nome: textoObrigatorio(corpo.nome, 'nome', { min: 2 }),
            ddd,
            telefone,
            email: emailOpcional(corpo.email),
            documento: corpo.documento ?? null,
          }),
        });
      }
    }

    // Tenta buscar por telefone normalizado
    const e164 = String(require('../../utilitarios/telefone.js').normalizarE164({ ddd, numero: telefone }));
    const db = require('../../banco/conexao.js').banco().db;
    const porTelefone = db.prepare('SELECT * FROM clientes WHERE telefone = ? AND ddd = ?').get(e164.slice(4), e164.slice(2, 4));
    if (porTelefone) {
      return res.json({
        dados: repo.atualizar(porTelefone.id, {
          nome: textoObrigatorio(corpo.nome, 'nome', { min: 2 }),
          ddd,
          telefone,
          email: emailOpcional(corpo.email),
          documento: corpo.documento ?? null,
        }),
      });
    }

    // Cria novo
    const cliente = repo.criar({
      nome: textoObrigatorio(corpo.nome, 'nome', { min: 2 }),
      ddd,
      telefone,
      email: emailOpcional(corpo.email),
      documento: corpo.documento ?? null,
    });

    res.status(201).json({ dados: cliente });
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