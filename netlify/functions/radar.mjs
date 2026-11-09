import { calcularATR, calcularEMA } from '../../lib/indicators.mjs';
import {
  analizarPatronBaseBajista,
  cruceBajistaReciente,
  detectarCruceBajista,
  detectarRechazoResistencia,
  evaluarZonaCompra,
  parsearZonasCompra,
} from '../../lib/strategy.mjs';

const DEFAULT_SYMBOL = 'NEARUSDT';
const MARKET_SYMBOL = 'BTCUSDT';
const INTERVAL = '15m';
const CANDLE_LIMIT = 150;
const BINANCE_API_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
];

const ultimo = (valores) => valores[valores.length - 1];
const numeroPositivo = (valor, predeterminado) => {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : predeterminado;
};

const descargarVelasDesde = async ({ simbolo, fetchImpl, apiBaseUrl, ahora }) => {
  const parametros = new URLSearchParams({
    symbol: simbolo,
    interval: INTERVAL,
    limit: String(CANDLE_LIMIT),
  });
  const respuesta = await fetchImpl(`${apiBaseUrl}/api/v3/klines?${parametros}`, {
    signal: AbortSignal.timeout(8_000),
  });

  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

  const datos = await respuesta.json();
  if (!Array.isArray(datos)) {
    throw new Error(`Respuesta inesperada de Binance para ${simbolo}.`);
  }

  const velas = datos
    .map((vela) => ({
      apertura: Number(vela[1]),
      maximo: Number(vela[2]),
      minimo: Number(vela[3]),
      cierre: Number(vela[4]),
      volumen: Number(vela[5]),
      cierreEn: Number(vela[6]),
    }))
    // La última vela de Binance puede seguir abierta; una señal sólo usa velas cerradas.
    .filter((vela) => (
      Object.values(vela).every(Number.isFinite)
      && vela.cierreEn < ahora
    ));

  if (velas.length < 60) {
    throw new Error(`Historial insuficiente para ${simbolo}: ${velas.length} velas cerradas.`);
  }

  return velas;
};

const descargarVelas = async ({ simbolo, fetchImpl, apiBaseUrls, ahora }) => {
  let ultimoError;

  for (const apiBaseUrl of apiBaseUrls) {
    try {
      const velas = await descargarVelasDesde({
        simbolo,
        fetchImpl,
        apiBaseUrl,
        ahora,
      });
      return { velas, apiBaseUrl };
    } catch (error) {
      ultimoError = error;
      console.warn(`Fuente ${apiBaseUrl} no disponible para ${simbolo}: ${error.message}`);
    }
  }

  throw new Error(
    `No se pudieron descargar velas de ${simbolo} desde ninguna fuente de Binance. `
    + `Último error: ${ultimoError?.message || 'desconocido'}`,
  );
};

const calcularIndicadores = (velas) => {
  const cierres = velas.map((vela) => vela.cierre);
  const maximos = velas.map((vela) => vela.maximo);
  const minimos = velas.map((vela) => vela.minimo);

  return {
    precio: ultimo(cierres),
    ema7: calcularEMA({ periodo: 7, valores: cierres }),
    ema25: calcularEMA({ periodo: 25, valores: cierres }),
    ema50: calcularEMA({ periodo: 50, valores: cierres }),
    atr14: calcularATR({
      periodo: 14,
      maximos,
      minimos,
      cierres,
    }),
    cierreEn: ultimo(velas).cierreEn,
  };
};

const enviarTelegram = async ({ token, chatId, mensaje, fetchImpl }) => {
  if (!token || !chatId) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Netlify.');
  }

  const respuesta = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Telegram rechazó la alerta (${respuesta.status}): ${detalle.slice(0, 180)}`);
  }
};

export const evaluarSetupCompleto = async ({
  fetchImpl = fetch,
  env = process.env,
  ahora = Date.now(),
} = {}) => {
  try {
    const simbolo = (env.TRADING_PAIR || DEFAULT_SYMBOL).toUpperCase();
    const apiBaseUrls = [
      env.BINANCE_API_BASE_URL,
      ...BINANCE_API_URLS,
    ].filter((url, indice, urls) => url && urls.indexOf(url) === indice);
    const toleranciaPorcentaje = numeroPositivo(
      env.ZONE_TOLERANCE_PERCENT,
      0.8,
    );
    const zonasConfiguradas = parsearZonasCompra(env.NEAR_SELL_ZONES);

    const [resultadoNear, resultadoBitcoin] = await Promise.all([
      descargarVelas({ simbolo, fetchImpl, apiBaseUrls, ahora }),
      descargarVelas({ simbolo: MARKET_SYMBOL, fetchImpl, apiBaseUrls, ahora }),
    ]);

    const near = calcularIndicadores(resultadoNear.velas);
    const bitcoin = calcularIndicadores(resultadoBitcoin.velas);

    const cruceBajista = detectarCruceBajista(near.ema7, near.ema25);
    const zona = evaluarZonaCompra({
      precio: near.precio,
      ema25: ultimo(near.ema25),
      atr: ultimo(near.atr14),
      zonasConfiguradas,
      toleranciaPorcentaje,
    });
    // BTC_FILTER: bajista (por defecto: precio < EMA25 < EMA50), no_alcista (BTC no está en
    // tendencia alcista) u off (sin filtro).
    const btcAlcista = (
      bitcoin.precio > ultimo(bitcoin.ema25)
      && ultimo(bitcoin.ema25) > ultimo(bitcoin.ema50)
    );
    const btcBajistaEstricto = (
      bitcoin.precio < ultimo(bitcoin.ema25)
      && ultimo(bitcoin.ema25) < ultimo(bitcoin.ema50)
    );
    const filtroBtc = (env.BTC_FILTER || 'bajista').toLowerCase();
    let contextoBitcoinBajista = btcBajistaEstricto;
    if (filtroBtc === 'off') contextoBitcoinBajista = true;
    else if (filtroBtc === 'no_alcista') contextoBitcoinBajista = !btcAlcista;

    // Patrón de compresión previa. PATTERN_MODE=informar sólo reporta, no bloquea.
    const modoPatron = (env.PATTERN_MODE || 'filtrar').toLowerCase();
    const ventanaReferencia = 20;
    const indiceAtrRef = resultadoNear.velas.length - 1 - ventanaReferencia - 13;
    const patron = analizarPatronBaseBajista({
      velas: resultadoNear.velas,
      atrReferencia: near.atr14[Math.max(0, indiceAtrRef)],
      umbralBase: numeroPositivo(env.BASE_RANGE_ATR, 0.6),
      umbralImpulso: numeroPositivo(env.IMPULSE_RANGE_ATR, 1.2),
      minVelasBase: numeroPositivo(env.MIN_BASE_CANDLES, 5),
    });
    const patronOk = modoPatron === 'informar' || patron.aprobado;
    const atrReferencia = near.atr14[Math.max(0, indiceAtrRef)];
    const rechazo = detectarRechazoResistencia({
      velas: resultadoNear.velas,
      patron,
      atrReferencia,
      ema25: ultimo(near.ema25),
      ratioMecha: numeroPositivo(env.REJECTION_WICK_RATIO, 0.4),
    });
    const crucePrevio = cruceBajistaReciente(near.ema7, near.ema25, 15);
    const distanciaEma25 = (near.precio - ultimo(near.ema25)) / ultimo(near.ema25) * 100;

    const modoSenal = (env.SIGNAL_MODE || 'rechazo').toLowerCase();
    const senalCruce = cruceBajista && zona.enZona && contextoBitcoinBajista && patronOk;
    const senalRechazo = crucePrevio && rechazo.hayRechazo && contextoBitcoinBajista;
    let tipoSenal = null;
    if (modoSenal !== 'cruce' && senalRechazo) tipoSenal = 'rechazo';
    else if (modoSenal !== 'rechazo' && senalCruce) tipoSenal = 'cruce';
    const setupConfirmado = tipoSenal !== null;
    const invalidacion = tipoSenal === 'rechazo'
      ? rechazo.invalidacion
      : near.precio + 1.5 * ultimo(near.atr14);

    const diagnostico = {
      simbolo,
      intervalo: INTERVAL,
      fuenteNear: new URL(resultadoNear.apiBaseUrl).hostname,
      fuenteBitcoin: new URL(resultadoBitcoin.apiBaseUrl).hostname,
      precio: near.precio,
      ema7: ultimo(near.ema7),
      ema25: ultimo(near.ema25),
      atr14: ultimo(near.atr14),
      cruceBajista,
      enZonaDeVenta: zona.enZona,
      referenciaZona: zona.referencia,
      tipoZona: zona.tipo,
      contextoBitcoinBajista,
      filtroBtc,
      btcBajistaEstricto,
      modoPatron,
      patronAprobado: patron.aprobado,
      baseVelas: patron.baseVelas,
      velasImpulso: patron.velasImpulso,
      motivoPatron: patron.motivo,
      modoSenal,
      cruceReciente: crucePrevio,
      hayRechazo: rechazo.hayRechazo,
      motivoRechazo: rechazo.motivo,
      tipoSenal,
      invalidacion: tipoSenal ? invalidacion : null,
      setupConfirmado,
      velaCerradaEn: new Date(near.cierreEn).toISOString(),
    };

    console.log('Diagnóstico cazador SHORT:', JSON.stringify(diagnostico));

    if (setupConfirmado) {
      const hora = new Date(near.cierreEn).toISOString();
      const mensaje = tipoSenal === 'rechazo'
        ? `🔴 *RECHAZO EN RESISTENCIA - SHORT: ${simbolo}* 🔴\n\n`
          + `*Precio:* ${near.precio.toFixed(4)} USDT\n`
          + `*Resistencia:* ${rechazo.resistencia} en ${rechazo.nivel.toFixed(4)} USDT\n`
          + `*Rechazo:* mecha superior de ${rechazo.porcentajeMecha.toFixed(0)}% tras `
          + `${rechazo.velasRetroceso} vela(s) de rebote\n`
          + `*Estructura:* ${patron.baseVelas} vela(s) de base, ${patron.velasImpulso} de impulso bajista\n`
          + `*Contexto:* Bitcoin bajista en 15m\n`
          + `*Invalidación:* cierre sobre ${rechazo.invalidacion.toFixed(4)} USDT\n`
          + `*Vela cerrada:* ${hora}\n\n`
          + `🎯 *Acción:* revisar entrada SHORT y gestionar el riesgo según tu plan.\n`
          + `_El bot sólo envía la señal; no abre operaciones._`
        : `🟠 *CRUCE SHORT (anticipado, sin confirmar resistencia): ${simbolo}* 🟠\n\n`
          + `*Precio:* ${near.precio.toFixed(4)} USDT\n`
          + `*Gatillo:* cruce bajista EMA(7) / EMA(25) en 15m\n`
          + `*Zona:* ${zona.tipo} en ${zona.referencia.toFixed(4)} USDT\n`
          + `*Patrón:* ${patron.motivo}\n`
          + `*Distancia a EMA25:* ${distanciaEma25.toFixed(2)}%\n`
          + `*Vela cerrada:* ${hora}\n\n`
          + `⚠️ Riesgo de judas swing bajista: espera el rechazo en resistencia.\n`
          + `_El bot sólo envía la señal; no abre operaciones._`;

      await enviarTelegram({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        mensaje,
        fetchImpl,
      });
      diagnostico.alertaTelegram = 'enviada';
    } else if (
      (env.SONDEO || 'off').toLowerCase() === 'on'
      && patron.hayImpulso
      && patron.indiceFin === resultadoNear.velas.length - 1
    ) {
      // Sondeo: avisa cuando acaba de formarse un impulso bajista aunque no sea señal completa,
      // y muestra qué condición del setup falló. NO es una señal de entrada.
      const marca = (ok) => (ok ? '✅' : '❌');
      const mensajeSondeo = `🧪 *SONDEO SHORT (no es señal): ${simbolo}* 🧪\n\n`
        + `*Precio:* ${near.precio.toFixed(4)} USDT\n`
        + `*Impulso bajista:* ${patron.velasImpulso} vela(s) que cierran en esta vela\n\n`
        + `${marca(contextoBitcoinBajista)} BTC (filtro: ${filtroBtc})\n`
        + `${marca(crucePrevio)} Cruce bajista EMA7/25 en las últimas 15 velas\n`
        + `${marca(patron.aprobado)} Base previa: ${patron.baseVelas} vela(s) `
        + `(mínimo ${numeroPositivo(env.MIN_BASE_CANDLES, 5)})\n`
        + `${marca(rechazo.hayRechazo)} Rechazo en resistencia: ${rechazo.motivo}\n\n`
        + `_Sólo para comparar con el gráfico; no abre operaciones._`;
      await enviarTelegram({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        mensaje: mensajeSondeo,
        fetchImpl,
      });
      diagnostico.alertaTelegram = 'sondeo';
    } else {
      diagnostico.alertaTelegram = 'sin señal';
    }

    return { statusCode: 200, body: JSON.stringify(diagnostico) };
  } catch (error) {
    console.error('Error en la evaluación de NEAR/USDT:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

export default async () => {
  const resultado = await evaluarSetupCompleto();
  return new Response(resultado.body, {
    status: resultado.statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  schedule: '*/15 * * * *',
};
