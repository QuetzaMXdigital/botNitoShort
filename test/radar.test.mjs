import test from 'node:test';
import assert from 'node:assert/strict';

import { calcularATR, calcularEMA } from '../lib/indicators.mjs';
import { evaluarSetupCompleto } from '../netlify/functions/radar.mjs';

import {
  detectarCruceAlcista,
  evaluarZonaCompra,
  parsearZonasCompra,
} from '../lib/strategy.mjs';

test('interpreta zonas de compra configuradas', () => {
  assert.deepEqual(parsearZonasCompra('2.10, 2.25, texto, -1'), [2.10, 2.25]);
});

test('calcula EMA con semilla de promedio simple', () => {
  assert.deepEqual(calcularEMA({ periodo: 3, valores: [1, 2, 3, 4] }), [2, 3]);
});

test('calcula ATR de una serie sin huecos', () => {
  const resultado = calcularATR({
    periodo: 3,
    maximos: [2, 3, 4, 5],
    minimos: [1, 2, 3, 4],
    cierres: [1.5, 2.5, 3.5, 4.5],
  });

  assert.equal(resultado.length, 2);
  assert.ok(resultado.every((valor) => valor > 0));
});

test('detecta únicamente un cruce alcista nuevo', () => {
  assert.equal(detectarCruceAlcista([0.98, 1.02], [1, 1]), true);
  assert.equal(detectarCruceAlcista([1.01, 1.02], [1, 1]), false);
});

test('usa una zona manual dentro de la tolerancia porcentual', () => {
  const resultado = evaluarZonaCompra({
    precio: 2.015,
    ema25: 2,
    atr: 0.02,
    zonasConfiguradas: [1.8, 2],
    toleranciaPorcentaje: 0.8,
  });

  assert.equal(resultado.enZona, true);
  assert.equal(resultado.referencia, 2);
  assert.equal(resultado.tipo, 'configurada');
});

test('usa EMA25 y ATR cuando no hay zonas manuales', () => {
  const resultado = evaluarZonaCompra({
    precio: 2.01,
    ema25: 2,
    atr: 0.04,
    toleranciaPorcentaje: 0.8,
  });

  assert.equal(resultado.enZona, true);
  assert.equal(resultado.referencia, 2);
  assert.equal(resultado.tipo, 'EMA25 dinámica');
});

test('evalúa NEAR y Bitcoin de extremo a extremo sin enviar una falsa señal', async () => {
  const inicio = Date.UTC(2026, 0, 1);
  const ahora = inicio + 151 * 15 * 60 * 1000;
  const crearVelas = (precioInicial, incremento) => Array.from({ length: 150 }, (_, indice) => {
    const cierre = precioInicial + incremento * indice;
    const aperturaEn = inicio + indice * 15 * 60 * 1000;
    return [
      aperturaEn,
      String(cierre),
      String(cierre + 0.01),
      String(cierre - 0.01),
      String(cierre),
      '1000',
      aperturaEn + 15 * 60 * 1000 - 1,
    ];
  });

  const near = crearVelas(2, 0);
  const bitcoin = crearVelas(50_000, 10);
  const consultas = [];
  const fetchImpl = async (url) => {
    consultas.push(url);
    const datos = url.includes('symbol=BTCUSDT') ? bitcoin : near;
    return new Response(JSON.stringify(datos), { status: 200 });
  };

  const resultado = await evaluarSetupCompleto({ fetchImpl, env: {}, ahora });
  const diagnostico = JSON.parse(resultado.body);

  assert.equal(resultado.statusCode, 200);
  assert.equal(diagnostico.simbolo, 'NEARUSDT');
  assert.equal(diagnostico.setupConfirmado, false);
  assert.equal(diagnostico.alertaTelegram, 'sin señal');
  assert.equal(consultas.length, 2);
});

test('cambia de servidor automáticamente cuando Binance responde 451', async () => {
  const inicio = Date.UTC(2026, 0, 1);
  const ahora = inicio + 151 * 15 * 60 * 1000;
  const velas = Array.from({ length: 150 }, (_, indice) => {
    const cierre = 2 + indice * 0.001;
    const aperturaEn = inicio + indice * 15 * 60 * 1000;
    return [
      aperturaEn,
      String(cierre),
      String(cierre + 0.01),
      String(cierre - 0.01),
      String(cierre),
      '1000',
      aperturaEn + 15 * 60 * 1000 - 1,
    ];
  });
  const consultas = [];
  const fetchImpl = async (url) => {
    consultas.push(url);
    if (url.startsWith('https://api.binance.com')) {
      return new Response('bloqueado por región', { status: 451 });
    }
    return new Response(JSON.stringify(velas), { status: 200 });
  };

  const resultado = await evaluarSetupCompleto({
    fetchImpl,
    env: { BINANCE_API_BASE_URL: 'https://api.binance.com' },
    ahora,
  });
  const diagnostico = JSON.parse(resultado.body);

  assert.equal(resultado.statusCode, 200);
  assert.equal(diagnostico.fuenteNear, 'data-api.binance.vision');
  assert.equal(diagnostico.fuenteBitcoin, 'data-api.binance.vision');
  assert.equal(consultas.length, 4);
});

import { analizarPatronBase } from '../lib/strategy.mjs';

const vela = (apertura, cierre, mecha = 0) => ({
  apertura,
  cierre,
  maximo: Math.max(apertura, cierre) + mecha,
  minimo: Math.min(apertura, cierre) - mecha,
});

test('aprueba base de 6 dojis seguida de 2 velas grandes y un retroceso', () => {
  const velas = [
    ...Array.from({ length: 10 }, () => vela(2, 2.001, 0.002)),
    ...Array.from({ length: 6 }, () => vela(2, 2.001, 0.002)),
    vela(2, 2.05, 0.005),
    vela(2.05, 2.1, 0.005),
    vela(2.1, 2.08, 0.005),
    vela(2.08, 2.12, 0.005),
  ];
  const patron = analizarPatronBase({ velas, atrReferencia: 0.02 });
  assert.equal(patron.aprobado, true);
  assert.equal(patron.baseVelas >= 5, true);
  assert.equal(patron.velasImpulso, 2);
  assert.equal(patron.hayRetroceso, true);
});

test('rechaza el patrón judas: sólo 1-2 velas de base y pico inmediato', () => {
  const velas = [
    ...Array.from({ length: 10 }, (_, i) => vela(2 + i * 0.01, 2 + (i + 1) * 0.01, 0.01)),
    vela(2.1, 2.101, 0.002),
    vela(2.101, 2.1, 0.002),
    vela(2.1, 2.16, 0.005),
    vela(2.16, 2.2, 0.005),
  ];
  const patron = analizarPatronBase({ velas, atrReferencia: 0.02 });
  assert.equal(patron.aprobado, false);
  assert.equal(patron.baseVelas <= 2, true);
});

test('rechaza si no hay vela de impulso reciente', () => {
  const velas = Array.from({ length: 30 }, () => vela(2, 2.001, 0.002));
  const patron = analizarPatronBase({ velas, atrReferencia: 0.02 });
  assert.equal(patron.aprobado, false);
  assert.equal(patron.hayImpulso, false);
});

import { cruceAlcistaReciente, detectarRechazoSoporte } from '../lib/strategy.mjs';

const velaOHLC = (apertura, maximo, minimo, cierre) => ({ apertura, maximo, minimo, cierre });
const baseDojis = (n) => Array.from({ length: n }, () => vela(2, 2.001, 0.002));

test('detecta rechazo: retroceso al techo de la base, mecha y cierre arriba', () => {
  const velas = [
    ...baseDojis(10),
    vela(2, 2.05, 0.005),
    vela(2.05, 2.1, 0.005),
    vela(2.1, 2.07, 0.005),
    vela(2.07, 2.04, 0.005),
    velaOHLC(2.03, 2.03, 2.0, 2.025),
  ];
  const patron = analizarPatronBase({ velas, atrReferencia: 0.02 });
  const rechazo = detectarRechazoSoporte({ velas, patron, atrReferencia: 0.02, ema25: 1.9 });
  assert.equal(rechazo.hayRechazo, true);
  assert.equal(rechazo.soporte, 'techo de la base');
  assert.equal(rechazo.velasRetroceso, 3);
});

test('no alerta si el retroceso pierde el soporte (judas swing)', () => {
  const velas = [
    ...Array.from({ length: 10 }, (_, i) => vela(2 + i * 0.01, 2 + (i + 1) * 0.01, 0.01)),
    vela(2.1, 2.101, 0.002),
    vela(2.101, 2.1, 0.002),
    vela(2.1, 2.16, 0.005),
    vela(2.16, 2.2, 0.005),
    vela(2.2, 2.12, 0.005),
    vela(2.12, 2.07, 0.005),
    velaOHLC(2.07, 2.08, 2.04, 2.05),
  ];
  const patron = analizarPatronBase({ velas, atrReferencia: 0.02 });
  const rechazo = detectarRechazoSoporte({ velas, patron, atrReferencia: 0.02, ema25: 2.0 });
  assert.equal(rechazo.hayRechazo, false);
});

test('no alerta mientras el impulso sigue en curso', () => {
  const velas = [...baseDojis(10), vela(2, 2.05, 0.005), vela(2.05, 2.1, 0.005)];
  const patron = analizarPatronBase({ velas, atrReferencia: 0.02 });
  const rechazo = detectarRechazoSoporte({ velas, patron, atrReferencia: 0.02, ema25: 1.9 });
  assert.equal(rechazo.hayRechazo, false);
});

test('cruceAlcistaReciente detecta cruces dentro de la ventana y respeta la vigencia', () => {
  assert.equal(cruceAlcistaReciente([0.9, 0.95, 1.05, 1.1, 1.12], [1, 1, 1, 1, 1], 5), true);
  assert.equal(cruceAlcistaReciente([1.1, 1.12, 1.15, 1.2, 1.2], [1, 1, 1, 1, 1], 3), false);
  assert.equal(cruceAlcistaReciente([0.9, 0.95, 1.05, 1.1, 0.99], [1, 1, 1, 1, 1], 5), false);
});

import {
  analizarPatronBaseBajista,
  cruceBajistaReciente,
  detectarCruceBajista,
  detectarRechazoResistencia,
} from '../lib/strategy.mjs';

test('SHORT: detecta únicamente un cruce bajista nuevo', () => {
  assert.equal(detectarCruceBajista([1.1, 0.95], [1, 1]), true);
  assert.equal(detectarCruceBajista([0.9, 0.95], [1, 1]), false);
  assert.equal(detectarCruceBajista([1.1, 1.05], [1, 1]), false);
});

test('SHORT: cruceBajistaReciente respeta ventana y vigencia', () => {
  assert.equal(cruceBajistaReciente([1.1, 1.05, 0.95, 0.9, 0.88], [1, 1, 1, 1, 1], 5), true);
  assert.equal(cruceBajistaReciente([0.9, 0.88, 0.85, 0.8, 0.8], [1, 1, 1, 1, 1], 3), false);
  assert.equal(cruceBajistaReciente([1.1, 1.05, 0.95, 0.9, 1.01], [1, 1, 1, 1, 1], 5), false);
});

test('SHORT: detecta rechazo en el piso de la base con mecha superior', () => {
  const velas = [
    ...baseDojis(10),
    vela(2, 1.95, 0.005),
    vela(1.95, 1.9, 0.005),
    vela(1.9, 1.93, 0.005),
    vela(1.93, 1.96, 0.005),
    velaOHLC(1.97, 2.0, 1.97, 1.975),
  ];
  const patron = analizarPatronBaseBajista({ velas, atrReferencia: 0.02 });
  assert.equal(patron.hayImpulso, true);
  assert.equal(patron.velasImpulso, 2);
  const rechazo = detectarRechazoResistencia({ velas, patron, atrReferencia: 0.02, ema25: 2.2 });
  assert.equal(rechazo.hayRechazo, true);
  assert.equal(rechazo.resistencia, 'piso de la base');
});

test('SHORT: no alerta si el rebote recupera la resistencia (judas bajista)', () => {
  const velas = [
    ...Array.from({ length: 10 }, (_, i) => vela(2 - i * 0.01, 2 - (i + 1) * 0.01, 0.01)),
    vela(1.9, 1.899, 0.002),
    vela(1.899, 1.9, 0.002),
    vela(1.9, 1.84, 0.005),
    vela(1.84, 1.8, 0.005),
    vela(1.8, 1.88, 0.005),
    vela(1.88, 1.93, 0.005),
    velaOHLC(1.93, 1.96, 1.92, 1.95),
  ];
  const patron = analizarPatronBaseBajista({ velas, atrReferencia: 0.02 });
  const rechazo = detectarRechazoResistencia({ velas, patron, atrReferencia: 0.02, ema25: 2.1 });
  assert.equal(rechazo.hayRechazo, false);
});

test('SHORT: no alerta mientras la caída sigue en curso', () => {
  const velas = [...baseDojis(10), vela(2, 1.95, 0.005), vela(1.95, 1.9, 0.005)];
  const patron = analizarPatronBaseBajista({ velas, atrReferencia: 0.02 });
  const rechazo = detectarRechazoResistencia({ velas, patron, atrReferencia: 0.02, ema25: 2.2 });
  assert.equal(rechazo.hayRechazo, false);
});
