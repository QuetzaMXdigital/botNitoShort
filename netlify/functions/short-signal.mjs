export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  const secret = process.env.QUETZA_SECRET_KEY || "";
  if (!secret || headers["x-quetza-secret"] !== secret) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const tipo = data.tipo_evento || "DISPARO_OPERATIVO";
  const symbol = data.symbol || "UNKNOWN";
  let alerta = "";

  if (tipo === "DIAGNOSTICO_ESTRUCTURA") {
    alerta =
      `🧭 <b>QUETZA BRAIN — ${data.estado || "OBSERVACION"}</b>\n\n` +
      `• <b>Par:</b> #${symbol}\n` +
      `• <b>Diagnóstico:</b> ${data.mensaje || ""}\n` +
      `🛑 <i>Zona de observación, NO de operación.</i>`;
  } else {
    if (data.direccion !== "SHORT") {
      return { statusCode: 200, body: JSON.stringify({ status: "ignored" }) };
    }
    const nodos = data.nodos || {};
    const header = data.confluencia_btc_near
      ? `🚨🔥 <b>CONFLUENCIA SHORT BTC + NEAR</b> (${data.desfase_confluencia_seg}s)\n`
      : `🔴 <b>BOTNITO SHORT — GATILLO ESTRUCTURAL</b>\n`;

    alerta =
      `${header}\n` +
      `• <b>Par:</b> #${symbol} @ <b>$${data.precio_gatillo || 0}</b>\n` +
      `• <b>Estructura 4m:</b> ${data.estructura_4m || "BAJISTA"}\n` +
      `• <b>Score Nodos:</b> ${data.score_sentimiento || 0}/100\n` +
      `• <b>Dominancia Venta:</b> ${nodos.nodo2_imbalance_pct || 0}%\n` +
      `• <b>Delta Neto (5s):</b> $${Math.round(nodos.nodo1_delta_usdt || 0).toLocaleString()} USDT\n`;
  }

  if (token && chatId) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: alerta, parse_mode: "HTML" }),
    });
  }

  return { statusCode: 200, body: JSON.stringify({ status: "ok", symbol }) };
};