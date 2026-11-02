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
