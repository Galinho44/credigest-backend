import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { paraCentavos, formatarBrasileiro, paraReaisGateway } from '../src/utilitarios/dinheiro.js';
import { normalizarE164, formatarParaExibicao } from '../src/utilitarios/telefone.js';
import { silenciarLogs } from './helpers/banco.js';

silenciarLogs();

/*
 * Estes testes existem porque ja hubo bug aqui: um `paraCentavos` aplicado
 * duas vezes (na rota E no repositorio) transformava R$ 850,00 em
 * R$ 850.000,00. Erro de dinheiro assim nao aparece como erro: aparece
 * como "o sistema ta estranho". Por isso o teste fixa a fronteira:
 * reais entram, centavos saem, e nunca mais se converte.
 */

describe('dinheiro: reais para centavos', () => {
  test('converte valor simples', () => {
    assert.equal(paraCentavos(850), 85000);
    assert.equal(paraCentavos(850.5), 85050);
    assert.equal(paraCentavos('1200.00'), 120000);
  });

  test('aceita virgula decimal, com e sem separador de milhar', () => {
    assert.equal(paraCentavos('1200,00'), 120000);
    assert.equal(paraCentavos('1.234,56'), 123456);
    assert.equal(paraCentavos('0,07'), 7);
    assert.equal(paraCentavos('R$ 1.234,56'), 123456);
  });

  test('recusa mais de 2 casas decimais em vez de adivinhar', () => {
    // 0.145 nao existe em real. Math.round(0.145 * 100) daria 14 porque
    // 0.145 * 100 = 14.499999999999998 em float: o sistema mudaria o
    // valor sozinho e ninguem teria pedido.
    assert.throws(() => paraCentavos(0.145), /2 casas decimais/i);
    assert.throws(() => paraCentavos(10.005), /2 casas decimais/i);
    assert.throws(() => paraCentavos('0.145'), /valor invalido/i);
  });

  test('aceita float que so tem 2 casas de verdade', () => {
    // 0.1 + 0.2 = 0.30000000000000004 tem que virar 30 centavos, nao
    // ser recusado por causa do ruido do float.
    assert.equal(paraCentavos(0.1 + 0.2), 30);
    assert.equal(paraCentavos(850.5), 85050);
    assert.equal(paraCentavos(1200.0), 120000);
  });

  test('rejeita valor negativo ou zero', () => {
    assert.throws(() => paraCentavos(0), /maior que zero/i);
    assert.throws(() => paraCentavos(-100), /maior que zero/i);
  });

  test('rejeita o que nao e numero', () => {
    assert.throws(() => paraCentavos('abc'), /valor invalido/i);
    assert.throws(() => paraCentavos(null), /obrigatorio/i);
    assert.throws(() => paraCentavos(undefined), /obrigatorio/i);
    assert.throws(() => paraCentavos(Number.NaN), /numero finito/i);
    assert.throws(() => paraCentavos({}), /tipo inesperado/i);
  });

  test('rejeita centavos passados por engano como reais', () => {
    // 85000 centavos (R$ 850,00) nunca pode virar 8.500.000. Este e' o
    // teste que pegaria a conversao dupla.
    assert.notEqual(paraCentavos(85000), 85000);
  });
});

describe('dinheiro: centavos para exibicao', () => {
  test('formata em reais brasileiro com espaco normal', () => {
    // O teste compararia "errado" sem isto: Intl usa espaço não separável
    // (U+00A0), que parece espaço mas tem outro código.
    assert.equal(formatarBrasileiro(85000), 'R$ 850,00');
    assert.equal(formatarBrasileiro(42050), 'R$ 420,50');
    assert.equal(formatarBrasileiro(7), 'R$ 0,07');
assert.ok(
      !formatarBrasileiro(85000).includes(' '),
      'nao deve conter U+00A0 (espaco nao separavel)'
    );
  });

  test('formata milhar com ponto', () => {
    assert.equal(formatarBrasileiro(120000), 'R$ 1.200,00');
  });

  test('zero e null viram zero, nao NaN', () => {
    assert.equal(formatarBrasileiro(0), 'R$ 0,00');
    assert.equal(formatarBrasileiro(null), 'R$ 0,00');
    assert.equal(formatarBrasileiro(undefined), 'R$ 0,00');
  });

  test('ida e volta preserva o valor', () => {
    for (const centavos of [1, 7, 99, 85000, 42050, 120000, 999999]) {
      const texto = formatarBrasileiro(centavos).replace(/[^\d,]/g, '').replace(',', '.');
      assert.equal(paraCentavos(texto), centavos, `falhou往返 em ${centavos}`);
    }
  });
});

describe('dinheiro: centavos para reais no gateway', () => {
  test('o Asaas recebe reais, nao centavos', () => {
    // Se isto mandar 85000, o gateway cobra R$ 85.000,00.
    assert.equal(paraReaisGateway(85000), 850);
    assert.equal(paraReaisGateway(42050), 420.5);
  });
});

describe('telefone: normalizacao E.164', () => {
  test('DDD + numero de 9 digitos', () => {
    assert.equal(normalizarE164({ ddd: '11', numero: '987654321' }), '5511987654321');
  });

  test('DDD + numero de 8 digitos (telefone antigo)', () => {
    assert.equal(normalizarE164({ ddd: '11', numero: '34567890' }), '551134567890');
  });

  test('aceita numero ja com DDD junto', () => {
    assert.equal(normalizarE164({ ddd: '21', numero: '21998877665' }), '5521998877665');
  });

  test('aceita numero ja com pais (55)', () => {
    assert.equal(normalizarE164({ ddd: '31', numero: '5531988776655' }), '5531988776655');
  });

  test('ignora pontuacao e espaco', () => {
    assert.equal(
      normalizarE164({ ddd: '48', numero: '(99887-7554)' }),
      '5548998877554'
    );
  });

  test('recusa DDD invalido', () => {
    assert.throws(() => normalizarE164({ ddd: '1', numero: '987654321' }), /DDD/i);
    assert.throws(() => normalizarE164({ ddd: 'ab', numero: '987654321' }), /DDD/i);
  });

  test('recusa numero de celular que nao comeca com 9', () => {
    // Celular em Brazil sempre comeca com 9. "887654321" e' fixo ou
    // numero errado, e um link wa.me errado abre a conversa com a
    // pessoa errada — ou com ninguem.
    assert.throws(() => normalizarE164({ ddd: '11', numero: '887654321' }), /9/i);
  });

  test('recusa numero vazio', () => {
    assert.throws(() => normalizarE164({ ddd: '11', numero: '' }), /telefone/i);
  });
});

describe('telefone: exibicao', () => {
  test('formata E.164 legivel', () => {
    // Formato internacional de proposito: e' o mesmo que o wa.me usa,
    // entonces o que aparece na tela confere com o link enviado.
    assert.equal(formatarParaExibicao('5511987654321'), '+55 11 98765-4321');
    assert.equal(formatarParaExibicao('557134567890'), '+55 71 3456-7890');
  });
});