const validarSerie = (nombre, valores, minimo) => {
  if (!Array.isArray(valores) || valores.length < minimo) {
    throw new Error(`${nombre} necesita al menos ${minimo} valores.`);
  }
  if (!valores.every(Number.isFinite)) {
    throw new Error(`${nombre} recibió un valor no numérico.`);
  }
};

export const calcularEMA = ({ periodo, valores }) => {
  validarSerie('EMA', valores, periodo);

  const multiplicador = 2 / (periodo + 1);
  let ema = valores.slice(0, periodo).reduce((suma, valor) => suma + valor, 0) / periodo;
  const resultados = [ema];

  for (let indice = periodo; indice < valores.length; indice += 1) {
    ema = (valores[indice] - ema) * multiplicador + ema;
    resultados.push(ema);
  }

  return resultados;
};

export const calcularATR = ({ periodo, maximos, minimos, cierres }) => {
  validarSerie('ATR máximos', maximos, periodo);
  validarSerie('ATR mínimos', minimos, periodo);
  validarSerie('ATR cierres', cierres, periodo);

  if (maximos.length !== minimos.length || maximos.length !== cierres.length) {
    throw new Error('ATR necesita series del mismo tamaño.');
  }

  const rangosVerdaderos = maximos.map((maximo, indice) => {
    if (indice === 0) return maximo - minimos[indice];
    return Math.max(
      maximo - minimos[indice],
      Math.abs(maximo - cierres[indice - 1]),
      Math.abs(minimos[indice] - cierres[indice - 1]),
    );
  });

  let atr = rangosVerdaderos
    .slice(0, periodo)
    .reduce((suma, valor) => suma + valor, 0) / periodo;
  const resultados = [atr];

  for (let indice = periodo; indice < rangosVerdaderos.length; indice += 1) {
    atr = ((atr * (periodo - 1)) + rangosVerdaderos[indice]) / periodo;
    resultados.push(atr);
  }

  return resultados;
};
