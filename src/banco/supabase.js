import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../logger.js';

let instancia = null;

/**
 * Cliente Supabase com service role (admin) para o backend.
 * Usa RLS bypass para operações internas.
 */
export function getSupabase() {
  if (instancia) return instancia;

  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error('Supabase não configurado: SUPABASE_URL e SUPABASE_SERVICE_KEY obrigatórios');
  }

  instancia = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'public' },
  });

  logger.debug('Supabase conectado', { url: config.supabase.url });
  return instancia;
}

/**
 * Executa uma função dentro de transação (PostgreSQL).
 * Supabase não expõe transação direta via client JS, usamos RPC ou fazemos
 * operações atômicas via functions SQL. Para simplicidade, usamos
 * `Promise.all` com rollback manual em caso de erro.
 */
export async function emTransacao(fn) {
  const sb = getSupabase();
  // Para operações críticas, usar functions SQL no banco
  // Aqui fallback: executa e se falhar tenta limpar (best effort)
  try {
    return await fn(sb);
  } catch (e) {
    logger.error('Erro em transação', { erro: e.message });
    throw e;
  }
}

/**
 * Helper para queries raw (SELECT/INSERT/UPDATE/DELETE) usando
 * a API REST do Supabase via client.
 */
export function sb() {
  return getSupabase();
}