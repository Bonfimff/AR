/**
 * Filtros de estabilização — simples e baratos, como exige rodar a 60 fps
 * num celular junto com AR e inferência de visão.
 */

/**
 * Filtro One Euro (Casiez et al.).
 * Escolhido porque resolve o dilema do hand tracking: corta o jitter quando a
 * mão está parada, mas quase não adiciona atraso quando ela se move rápido.
 * Um passa-baixa fixo faria uma coisa ou outra, nunca as duas.
 */
export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.lastValue = null;
    this.lastDerivative = 0;
    this.lastTime = null;
  }

  filter(value, time) {
    if (this.lastValue === null || this.lastTime === null) {
      this.lastValue = value;
      this.lastTime = time;
      return value;
    }

    const dt = Math.max(time - this.lastTime, 1e-4);
    this.lastTime = time;

    const derivative = (value - this.lastValue) / dt;
    this.lastDerivative = lowPass(derivative, this.lastDerivative, alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(this.lastDerivative);
    this.lastValue = lowPass(value, this.lastValue, alpha(cutoff, dt));
    return this.lastValue;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lowPass(value, previous, a) {
  return a * value + (1 - a) * previous;
}

/** Dois OneEuro em paralelo, para um ponto 2D. */
export class OneEuroVec2 {
  constructor(options) {
    this.x = new OneEuroFilter(options);
    this.y = new OneEuroFilter(options);
  }
  reset() {
    this.x.reset();
    this.y.reset();
  }
  filter(point, time, out = {}) {
    out.x = this.x.filter(point.x, time);
    out.y = this.y.filter(point.y, time);
    return out;
  }
}

/**
 * Gatilho booleano com histerese + debounce.
 * Histerese impede o "liga/desliga" quando o valor fica em cima do limiar;
 * o debounce impede que um único frame ruim solte o objeto.
 */
export class HysteresisGate {
  constructor({ onBelow, offAbove, framesToOn = 2, framesToOff = 3 }) {
    this.onBelow = onBelow;
    this.offAbove = offAbove;
    this.framesToOn = framesToOn;
    this.framesToOff = framesToOff;
    this.active = false;
    this.streak = 0;
  }

  reset() {
    this.active = false;
    this.streak = 0;
  }

  /** @param {number} value @param {number} [offAbove] limiar de saída sobrescrito */
  update(value, offAbove = this.offAbove) {
    const wants = this.active ? !(value > offAbove) : value < this.onBelow;
    if (wants === this.active) {
      this.streak = 0;
      return this.active;
    }
    this.streak += 1;
    const needed = this.active ? this.framesToOff : this.framesToOn;
    if (this.streak >= needed) {
      this.active = wants;
      this.streak = 0;
    }
    return this.active;
  }
}
