import { ErroDeValidacao } from './erros.js';

/**
 * Dinheiro na Credigest.
 *
 * REGRA: dentro do sistema dinheiro e INTEIRO em centavos.
 * Ponto flutuante so aparece na borda (entrada do usuario / saida HTTP),
 * e entra/sai por estas funcoes. Isso elimina a classe de bug em que
 * 0.1 + 0.2 = 0.30000000000000004 e a soma da divida "nao bate".
 */

/** Converte "R$ 1.234,56", "1.234,56", "1234.56", "1234", 1234.56 -> 123456 centavos. */
export function paraCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') {
    throw new ErroDeValidacao('valor e obrigatorio', { codigo: 'VALOR_AUSENTE' });
  }

  let centavos;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) {
      throw new ErroDeValidacao('valor precisa ser um numero finito', { codigo: 'VALOR_INVALIDO' });
    }
    centavos = Math.round(paraDuasCasas(valor) * 100);
  } else if (typeof valor === 'string') {
    // Aceita as duas convencoes: "1.234,56" / "1200,00" (pt-BR) e "1234.56" (API).
    //
    // O primeiro ramo aceita virgula com OU sem separador de milhar.
    // Uma versao anterior exigia os pontos ("1200,00" era rejeitado), o
    // que soava como bug para quem digita no teclado brasileiro.
    const limpo = valor.trim().replace(/[R$\s]/g, '');
    if (!/^\d+(?:\.\d{3})*,\d{2}$|^\d+(?:\.\d{1,2})?$/.test(limpo)) {
      throw new ErroDeValidacao(
        `valor invalido: "${valor}". Use 1234.56 ou "R\$ 1.234,56"`,
        { codigo: 'VALOR_INVALIDO' }
      );
    }
    const normalizado = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
    centavos = Math.round(Number(normalizado) * 100);
  } else {
    throw new ErroDeValidacao('valor invalido: tipo inesperado', { codigo: 'VALOR_INVALIDO' });
  }

  if (centavos <= 0) {
    throw new ErroDeValidacao('valor tem que ser maior que zero', { codigo: 'VALOR_NAO_POSITIVO' });
  }
  if (centavos > 100_000_000_00) {
    throw new ErroDeValidacao('valor acima do limite permitido', { codigo: 'VALOR_ACIMA_DO_LIMITE' });
  }
  return centavos;
}

/**
 * Garante que um numero nao tem mais de 2 casas decimais de verdade.
 *
 * Real em BRL para no centavo: 0,145 nao existe. Math.round(0.145 * 100)
 * devolve 14 porque 0.145 * 100 = 14.499999999999998 em float — ou seja,
 * o sistema "arredondaria" 14,5 para 14 e o valor viraria outro sem
 * ninguém pedir. Numero que tem sub-centavo de verdade e' erro de
 * digitação ou de integração, entao recusamos em vez de adivinhar.
 *
 * A tolerância de 1e-9 existe para os casos que sao "2 casas de verdade,
 * mas o float sujou": 0.1 + 0.2 = 0.30000000000000004 tem que entrar
 * como 30 centavos.
 */
function paraDuasCasas(valor) {
  const arredondado = Math.round(valor * 100) / 100;
  if (arredondado !== valor && Math.abs(arredondado - valor) > 1e-9) {
    throw new ErroDeValidacao(
      `valor tem mais de 2 casas decimais: ${valor}. Real so vai ate o centavo (ex.: ${arredondado}).`,
      { codigo: 'VALOR_COM_SUB_CENTAVO' }
    );
  }
  return valor;
}

/** 123456 -> "R$ 1.234,56" (pt-BR, para exibir na tela e na mensagem do WhatsApp). */
export function formatarBrasileiro(centavos) {
  const n = Number(centavos) || 0;
  const texto = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n / 100);
  // Intl escreve espaço NÃO-SEPARÁVEL (U+00A0) entre "R$" e o número. Ele
  // parece espaço, mas quebra comparação de string e some em log/diff.
  // A troca por espaço normal não muda a aparência e torna o texto
  // previsível para teste, banco e comparação.
return texto.replace(/\u00A0/g, ' ');
}

/** 123456 -> 1234.56 (formato que o Asaas espera: numero com 2 casas). */
export function paraReaisGateway(centavos) {
  return Number((Number(centavos) / 100).toFixed(2));
}