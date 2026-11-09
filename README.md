# Cazador SHORT (Radar)

Bot de alertas en Netlify (cron cada 15 min). **No abre operaciones**: sólo avisa por Telegram.
Es el espejo bajista del cazador LONG.

## Lógica (modo `rechazo`, por defecto)

1. Cruce **bajista** EMA7/EMA25 en 15m dentro de las últimas 15 velas, aún vigente.
2. Bitcoin bajista en 15m (`precio < EMA25 < EMA50`).
3. Estructura: base de velas pequeñas/doji y una o más velas rojas grandes (impulso).
4. Rebote hacia el **piso de la base** (o la EMA25), con **mecha superior** y cierre por debajo.
5. Se descarta si algún cierre del rebote recupera la resistencia, o si el rebote supera el
   máximo donde arrancó el impulso (posible judas swing bajista / squeeze).

La alerta trae la resistencia usada, el % de mecha, la estructura y un nivel de invalidación.

## Variables de entorno

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (obligatorias para enviar alertas).
- `TRADING_PAIR`: par a vigilar; `NEARUSDT` por defecto.
- `SIGNAL_MODE`: `rechazo` (por defecto), `cruce` o `ambos` (el cruce anticipado sale con 🟠).
- `BTC_FILTER`: `bajista` (por defecto, precio < EMA25 < EMA50), `no_alcista` (BTC no está en
  tendencia alcista) u `off` (sin filtro).
- `SONDEO`: `on` envía un mensaje 🧪 cuando acaba de formarse un impulso bajista aunque no sea
  señal completa, con un checklist de qué condición falló. No es una señal de entrada. `off` por defecto.
- `TEST_KEY`: clave para la prueba de Telegram (ver más abajo).
- `PATTERN_MODE`: `filtrar` (por defecto) o `informar`.
- `MIN_BASE_CANDLES` (5), `BASE_RANGE_ATR` (0.6), `IMPULSE_RANGE_ATR` (1.2),
  `REJECTION_WICK_RATIO` (0.4).
- `NEAR_SELL_ZONES`: niveles de resistencia manuales separados por coma (opcional).
- `ZONE_TOLERANCE_PERCENT`: tolerancia de zona para el cruce anticipado; `0.8`.
- `BINANCE_API_BASE_URL`: servidor alternativo de Binance (opcional).

## Pruebas

```bash
npm test
```

## Probar la comunicación con Telegram

Independiente del mercado. Define `TEST_KEY` en Netlify (cualquier texto largo y secreto), vuelve a
desplegar y abre en el navegador:

```
https://TU-SITIO.netlify.app/.netlify/functions/test-telegram?key=TU_CLAVE
```

Si llega el mensaje "Prueba de comunicación del bot SHORT" a tu chat, Telegram funciona. Si no,
la respuesta JSON explica el motivo (por ejemplo `chat not found` o `Unauthorized`).
Sin `TEST_KEY` definida, la función rechaza toda petición.

## Backtest

Reproduce la lógica real del bot vela a vela sobre el historial de Binance y mide cada señal
contra su invalidación (stop por encima de la entrada) y un objetivo en múltiplos de R.
Requiere Node 20 y red.

```bash
node scripts/backtest.mjs --days 60
SIGNAL_MODE=ambos BTC_FILTER=no_alcista node scripts/backtest.mjs --days 60
```

Opciones: `--symbol`, `--days` (30), `--horizon` velas máximas por señal (48), `--target` en R (2).
Imprime cada señal con su resultado y un resumen, y guarda `backtest-resultados.csv`.
Si el stop y el objetivo caen en la misma vela, se asume que el stop se toca primero.
Con menos de ~20 señales los porcentajes no son concluyentes.
