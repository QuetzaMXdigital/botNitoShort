const ultimo = (valores) => valores[valores.length - 1];
const penultimo = (valores) => valores[valores.length - 2];

export const parsearZonasCompra = (valor = '') => valor
  .split(',')
  .map((zona) => Number(zona.trim()))
  .filter((zona) => Number.isFinite(zona) && zona > 0);

export const detectarCruceAlcista = (emaRapida, emaLenta) => (
  penultimo(emaRapida) <= penultimo(emaLenta)
  && ultimo(emaRapida) > ultimo(emaLenta)
);

export const evaluarZonaCompra = ({
  precio,
  ema25,
  atr,
  zonasConfiguradas = [],
  toleranciaPorcentaje = 0.8,
}) => {
  if (zonasConfiguradas.length > 0) {
    const zonaMasCercana = zonasConfiguradas.reduce((cercana, zona) => (
      Math.abs(precio - zona) < Math.abs(precio - cercana) ? zona : cercana
    ));
    const distanciaPorcentaje = Math.abs(precio - zonaMasCercana) / zonaMasCercana * 100;

    return {
      enZona: distanciaPorcentaje <= toleranciaPorcentaje,
      referencia: zonaMasCercana,
      tipo: 'configurada',
      toleranciaPorcentaje,
    };
  }

  // Sin niveles manuales, la EMA25 funciona como soporte dinámico.
  // El ATR amplía la tolerancia cuando NEAR presenta mayor volatilidad.
  const toleranciaAtr = atr / ema25 * 100 * 0.75;
  const toleranciaDinamica = Math.max(toleranciaPorcentaje, toleranciaAtr);
  const distanciaPorcentaje = Math.abs(precio - ema25) / ema25 * 100;

  return {
    enZona: distanciaPorcentaje <= toleranciaDinamica,
    referencia: ema25,
    tipo: 'EMA25 dinámica',
    toleranciaPorcentaje: toleranciaDinamica,
  };
};

// Patrón de "compresión → expansión":
//   Setups buenos: 5-8 velas pequeñas/doji (base) y luego 2 velas grandes alcistas.
//   Judas swing: sólo 1-2 velas de base y un pico inmediato que se revierte.
// Todos los tamaños se miden contra un ATR de referencia previo al movimiento,
// para que el propio impulso no "infle" la vara de medir.
export const analizarPatronBase = ({
  velas,
  atrReferencia,
  umbralBase = 0.6,
  umbralImpulso = 1.2,
  minVelasBase = 5,
  maxVelasDesdeImpulso = 8,
}) => {
  const rango = (vela) => vela.maximo - vela.minimo;
  const esBase = (vela) => {
    const r = rango(vela);
    return r <= umbralBase * atrReferencia
      || (r <= atrReferencia && Math.abs(vela.cierre - vela.apertura) <= 0.3 * r);
  };
  const esImpulso = (vela) => (
    vela.cierre > vela.apertura && rango(vela) >= umbralImpulso * atrReferencia
  );

  const total = velas.length;
  const desde = Math.max(1, total - maxVelasDesdeImpulso);
  let inicio = -1;
  for (let i = desde; i < total; i += 1) {
    if (esImpulso(velas[i])) { inicio = i; break; }
  }

  if (inicio === -1) {
    return {
      aprobado: false, hayImpulso: false, baseVelas: 0, velasImpulso: 0, hayRetroceso: false,
      indiceInicio: -1, indiceFin: -1, maximoBase: NaN,
      motivo: `sin vela de impulso en las últimas ${maxVelasDesdeImpulso} velas`,
    };
  }

  // Si el impulso ya venía de antes, retrocede hasta el primer impulso de esa racha.
  while (inicio > 0 && esImpulso(velas[inicio - 1])) inicio -= 1;

  let baseVelas = 0;
  for (let k = inicio - 1; k >= 0 && esBase(velas[k]); k -= 1) baseVelas += 1;

  let fin = inicio;
  while (fin + 1 < total && esImpulso(velas[fin + 1])) fin += 1;
  const velasImpulso = fin - inicio + 1;
  const hayRetroceso = velas.slice(fin + 1).some((vela) => vela.cierre < vela.apertura);

  const maximoBase = baseVelas > 0
    ? Math.max(...velas.slice(inicio - baseVelas, inicio).map((vela) => vela.maximo))
    : velas[inicio].apertura;

  const aprobado = baseVelas >= minVelasBase;
  return {
    aprobado,
    hayImpulso: true,
    baseVelas,
    velasImpulso,
    hayRetroceso,
    indiceInicio: inicio,
    indiceFin: fin,
    maximoBase,
    motivo: aprobado
      ? `base de ${baseVelas} velas antes del impulso`
      : `base de sólo ${baseVelas} velas (mínimo ${minVelasBase}): patrón tipo judas swing`,
  };
};

// ¿Hubo un cruce EMA rápida/lenta alcista en las últimas `ventana` velas y sigue vigente?
export const cruceAlcistaReciente = (emaRapida, emaLenta, ventana = 15) => {
  const largo = Math.min(emaRapida.length, emaLenta.length);
  const rapida = (k) => emaRapida[emaRapida.length - 1 - k];
  const lenta = (k) => emaLenta[emaLenta.length - 1 - k];
  if (!(rapida(0) > lenta(0))) return false;
  for (let k = 0; k < Math.min(ventana, largo - 1); k += 1) {
    if (rapida(k + 1) <= lenta(k + 1) && rapida(k) > lenta(k)) return true;
  }
  return false;
};

// Rechazo en soporte: tras el impulso el precio regresa al techo de la base (o a la EMA25),
// lo barre con una mecha inferior y cierra por encima. El judas swing pierde ese soporte.
export const detectarRechazoSoporte = ({
  velas,
  patron,
  atrReferencia,
  ema25,
  ratioMecha = 0.4,
  toleranciaToque = 0.3,
  toleranciaCierre = 0.15,
  maxVelasRetroceso = 12,
}) => {
  const sin = (motivo) => ({ hayRechazo: false, motivo });
  if (!patron.hayImpulso) return sin('sin impulso reciente');

  const retroceso = velas.slice(patron.indiceFin + 1);
  if (retroceso.length === 0) return sin('el impulso sigue en curso; esperando retroceso');
  if (retroceso.length > maxVelasRetroceso) return sin('el retroceso es demasiado antiguo');

  const origen = velas[patron.indiceInicio].minimo;
  if (retroceso.some((vela) => vela.minimo < origen)) {
    return sin('el retroceso rompió el origen del impulso (posible judas)');
  }

  const esRechazo = (vela, nivel) => {
    const rango = vela.maximo - vela.minimo;
    if (rango <= 0) return false;
    const mecha = Math.min(vela.apertura, vela.cierre) - vela.minimo;
    return vela.minimo <= nivel + toleranciaToque * atrReferencia
      && vela.cierre >= nivel
      && mecha / rango >= ratioMecha
      && vela.cierre >= vela.minimo + rango * 0.5;
  };

  const soportes = [
    { tipo: 'techo de la base', nivel: patron.maximoBase },
    { tipo: 'EMA25', nivel: ema25 },
  ].filter((soporte) => Number.isFinite(soporte.nivel));

  const ultimaVela = velas[velas.length - 1];
  for (const soporte of soportes) {
    const sostenido = retroceso.every(
      (vela) => vela.cierre >= soporte.nivel - toleranciaCierre * atrReferencia,
    );
    const previos = retroceso.slice(0, -1);
    const esPrimerRechazo = !previos.some((vela) => esRechazo(vela, soporte.nivel));
    if (sostenido && esPrimerRechazo && esRechazo(ultimaVela, soporte.nivel)) {
      const rango = ultimaVela.maximo - ultimaVela.minimo;
      return {
        hayRechazo: true,
        soporte: soporte.tipo,
        nivel: soporte.nivel,
        velasRetroceso: retroceso.length,
        porcentajeMecha: (Math.min(ultimaVela.apertura, ultimaVela.cierre) - ultimaVela.minimo)
          / rango * 100,
        invalidacion: ultimaVela.minimo - 0.2 * atrReferencia,
        motivo: `rechazo en ${soporte.tipo} tras ${retroceso.length} vela(s) de retroceso`,
      };
    }
  }
  return sin('sin rechazo válido en soporte');
};

// ===================== SHORT (espejo de la lógica de long) =====================

export const detectarCruceBajista = (emaRapida, emaLenta) => (
  penultimo(emaRapida) >= penultimo(emaLenta)
  && ultimo(emaRapida) < ultimo(emaLenta)
);

export const cruceBajistaReciente = (emaRapida, emaLenta, ventana = 15) => {
  const largo = Math.min(emaRapida.length, emaLenta.length);
  const rapida = (k) => emaRapida[emaRapida.length - 1 - k];
  const lenta = (k) => emaLenta[emaLenta.length - 1 - k];
  if (!(rapida(0) < lenta(0))) return false;
  for (let k = 0; k < Math.min(ventana, largo - 1); k += 1) {
    if (rapida(k + 1) >= lenta(k + 1) && rapida(k) < lenta(k)) return true;
  }
  return false;
};

// Compresión → expansión bajista: base de velas pequeñas y luego velas rojas grandes.
// El judas swing bajista es una caída falsa (barrido de stops) que se revierte.
export const analizarPatronBaseBajista = ({
  velas,
  atrReferencia,
  umbralBase = 0.6,
  umbralImpulso = 1.2,
  minVelasBase = 5,
  maxVelasDesdeImpulso = 8,
}) => {
  const rango = (vela) => vela.maximo - vela.minimo;
  const esBase = (vela) => {
    const r = rango(vela);
    return r <= umbralBase * atrReferencia
      || (r <= atrReferencia && Math.abs(vela.cierre - vela.apertura) <= 0.3 * r);
  };
  const esImpulso = (vela) => (
    vela.cierre < vela.apertura && rango(vela) >= umbralImpulso * atrReferencia
  );

  const total = velas.length;
  const desde = Math.max(1, total - maxVelasDesdeImpulso);
  let inicio = -1;
  for (let i = desde; i < total; i += 1) {
    if (esImpulso(velas[i])) { inicio = i; break; }
  }

  if (inicio === -1) {
    return {
      aprobado: false, hayImpulso: false, baseVelas: 0, velasImpulso: 0, hayRetroceso: false,
      indiceInicio: -1, indiceFin: -1, minimoBase: NaN,
      motivo: `sin vela de impulso bajista en las últimas ${maxVelasDesdeImpulso} velas`,
    };
  }

  while (inicio > 0 && esImpulso(velas[inicio - 1])) inicio -= 1;

  let baseVelas = 0;
  for (let k = inicio - 1; k >= 0 && esBase(velas[k]); k -= 1) baseVelas += 1;

  let fin = inicio;
  while (fin + 1 < total && esImpulso(velas[fin + 1])) fin += 1;
  const velasImpulso = fin - inicio + 1;
  const hayRetroceso = velas.slice(fin + 1).some((vela) => vela.cierre > vela.apertura);

  const minimoBase = baseVelas > 0
    ? Math.min(...velas.slice(inicio - baseVelas, inicio).map((vela) => vela.minimo))
    : velas[inicio].apertura;

  const aprobado = baseVelas >= minVelasBase;
  return {
    aprobado,
    hayImpulso: true,
    baseVelas,
    velasImpulso,
    hayRetroceso,
    indiceInicio: inicio,
    indiceFin: fin,
    minimoBase,
    motivo: aprobado
      ? `base de ${baseVelas} velas antes del impulso bajista`
      : `base de sólo ${baseVelas} velas (mínimo ${minVelasBase}): patrón tipo judas swing`,
  };
};

// Rechazo en resistencia: tras la caída, el precio rebota al piso de la base (o a la EMA25),
// lo barre con una mecha superior y cierra por debajo. El judas bajista recupera esa resistencia.
export const detectarRechazoResistencia = ({
  velas,
  patron,
  atrReferencia,
  ema25,
  ratioMecha = 0.4,
  toleranciaToque = 0.3,
  toleranciaCierre = 0.15,
  maxVelasRetroceso = 12,
}) => {
  const sin = (motivo) => ({ hayRechazo: false, motivo });
  if (!patron.hayImpulso) return sin('sin impulso bajista reciente');

  const retroceso = velas.slice(patron.indiceFin + 1);
  if (retroceso.length === 0) return sin('el impulso sigue en curso; esperando rebote');
  if (retroceso.length > maxVelasRetroceso) return sin('el rebote es demasiado antiguo');

  const origen = velas[patron.indiceInicio].maximo;
  if (retroceso.some((vela) => vela.maximo > origen)) {
    return sin('el rebote superó el origen del impulso (posible judas)');
  }

  const esRechazo = (vela, nivel) => {
    const rango = vela.maximo - vela.minimo;
    if (rango <= 0) return false;
    const mecha = vela.maximo - Math.max(vela.apertura, vela.cierre);
    return vela.maximo >= nivel - toleranciaToque * atrReferencia
      && vela.cierre <= nivel
      && mecha / rango >= ratioMecha
      && vela.cierre <= vela.maximo - rango * 0.5;
  };

  const resistencias = [
    { tipo: 'piso de la base', nivel: patron.minimoBase },
    { tipo: 'EMA25', nivel: ema25 },
  ].filter((resistencia) => Number.isFinite(resistencia.nivel));

  const ultimaVela = velas[velas.length - 1];
  for (const resistencia of resistencias) {
    const sostenida = retroceso.every(
      (vela) => vela.cierre <= resistencia.nivel + toleranciaCierre * atrReferencia,
    );
    const previos = retroceso.slice(0, -1);
    const esPrimerRechazo = !previos.some((vela) => esRechazo(vela, resistencia.nivel));
    if (sostenida && esPrimerRechazo && esRechazo(ultimaVela, resistencia.nivel)) {
      const rango = ultimaVela.maximo - ultimaVela.minimo;
      return {
        hayRechazo: true,
        resistencia: resistencia.tipo,
        nivel: resistencia.nivel,
        velasRetroceso: retroceso.length,
        porcentajeMecha: (ultimaVela.maximo - Math.max(ultimaVela.apertura, ultimaVela.cierre))
          / rango * 100,
        invalidacion: ultimaVela.maximo + 0.2 * atrReferencia,
        motivo: `rechazo en ${resistencia.tipo} tras ${retroceso.length} vela(s) de rebote`,
      };
    }
  }
  return sin('sin rechazo válido en resistencia');
};
