/**
 * Painel de diagnóstico técnico. Existe para responder, no aparelho, qual
 * camada está de fato ativa — e pode ser escondido para a apresentação.
 */
const ROWS = [
  ["ar", "AR"],
  ["hitTest", "HIT TEST"],
  ["hand", "HAND TRACKING"],
  ["depth", "DEPTH"],
  ["orient", "DEPTH ORIENT"],
  ["mask", "HAND MASK"],
  ["camera", "CAM FRAME"],
  ["infer", "INFERENCIAS"],
  ["handDetected", "HAND"],
  ["pinch", "PINCH"],
  ["object", "OBJECT"],
  ["state", "STATE"],
  ["rollDelta", "ROLL Δ"],
  ["scaleDelta", "SCALE Δ"],
  ["fps", "FPS"],
];

const UPDATE_INTERVAL_MS = 250;

export class Diagnostics {
  constructor(root) {
    this.root = root;
    this.cells = new Map();
    this.lastUpdate = 0;
    this.visible = false;

    for (const [key, label] of ROWS) {
      const row = document.createElement("div");
      row.className = "diag-row";
      const name = document.createElement("span");
      name.textContent = label;
      const value = document.createElement("b");
      value.textContent = "—";
      row.append(name, value);
      root.append(row);
      this.cells.set(key, value);
    }
  }

  setVisible(visible) {
    this.visible = visible;
    this.root.hidden = !visible;
  }

  toggle() {
    this.setVisible(!this.visible);
    return this.visible;
  }

  /** Barato: só toca no DOM 4x por segundo, mesmo sendo chamado a cada frame. */
  update(data, now) {
    if (!this.visible || now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;
    for (const [key, cell] of this.cells) {
      const value = data[key];
      if (value === undefined) continue;
      const text = String(value);
      if (cell.textContent !== text) cell.textContent = text;
    }
  }
}

/** Média móvel simples de FPS. */
export class FpsMeter {
  constructor(samples = 30) {
    this.samples = samples;
    this.times = [];
  }
  tick(delta) {
    if (delta <= 0) return;
    this.times.push(delta);
    if (this.times.length > this.samples) this.times.shift();
  }
  get value() {
    if (!this.times.length) return 0;
    const sum = this.times.reduce((a, b) => a + b, 0);
    return Math.round(this.times.length / sum);
  }
}
