import { OneEuroFilter, OneEuroVec2, HysteresisGate } from "../filters.js";

/**
 * Landmarks -> sinais estáveis de gesto.
 *
 * Recebe pontos da mão já em coordenadas normalizadas de tela [0..1], venham
 * eles do MediaPipe ou do WebXR Hand Input, e devolve sempre a mesma estrutura.
 * Toda a estabilização (One Euro + histerese + debounce) mora aqui.
 */

/** Índices dos landmarks do MediaPipe Hand Landmarker. */
export const LANDMARK = {
  wrist: 0,
  thumbMcp: 2,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyPip: 18,
  pinkyTip: 20,
};

/** Dedos identificados, para diagnóstico e para medir a mão aberta. */
export const FINGERS = {
  polegar: { tip: LANDMARK.thumbTip, pip: LANDMARK.thumbMcp },
  indicador: { tip: LANDMARK.indexTip, pip: LANDMARK.indexPip },
  medio: { tip: LANDMARK.middleTip, pip: LANDMARK.middlePip },
  anelar: { tip: LANDMARK.ringTip, pip: LANDMARK.ringPip },
  minimo: { tip: LANDMARK.pinkyTip, pip: LANDMARK.pinkyPip },
};

// Limiares da pinça, em FRAÇÃO DO TAMANHO DA MÃO — não em pixels. É isso que
// os torna adaptativos: valem igual com a mão perto ou longe da câmera.
const PINCH_ON = 0.42;
const PINCH_OFF = 0.62;

export class HandAnalyzer {
  constructor() {
    this.pinchPoint = new OneEuroVec2({ minCutoff: 1.4, beta: 0.03 });
    this.palmPoint = new OneEuroVec2({ minCutoff: 1.0, beta: 0.02 });
    // A razão só alimenta o portão de pinça (aberta/fechada) — a escala saiu
    // dos gestos de mão e virou controle de tela, ver hand-controller.js.
    this.ratio = new OneEuroFilter({ minCutoff: 1.6, beta: 0.04 });
    // beta mais alto que os outros filtros: um giro de pulso deliberado é
    // rápido, e o beta baixo herdado do sinal antigo (punho->dedo médio, que
    // mal se movia) suavizava a maior parte do movimento antes de acumular no
    // limiar — provável razão de girar ainda não funcionar mesmo depois de
    // trocar a fonte do sinal.
    this.rollFilter = new OneEuroFilter({ minCutoff: 1.5, beta: 0.06 });
    this.gate = new HysteresisGate({ onBelow: PINCH_ON, offAbove: PINCH_OFF });
    this.unwrappedRoll = 0;
    this.lastRawRoll = null;
    this._out = {};
  }

  reset() {
    this.pinchPoint.reset();
    this.palmPoint.reset();
    this.ratio.reset();
    this.rollFilter.reset();
    this.gate.reset();
    this.unwrappedRoll = 0;
    this.lastRawRoll = null;
  }

  /**
   * @param {Array<{x:number,y:number}>} points 21 landmarks em [0..1]
   * @param {number} time segundos
   */
  analyze(points, time) {
    const wrist = points[LANDMARK.wrist];
    const middleMcp = points[LANDMARK.middleMcp];
    const thumbTip = points[LANDMARK.thumbTip];
    const indexTip = points[LANDMARK.indexTip];
    const indexMcp = points[LANDMARK.indexMcp];
    const pinkyMcp = points[LANDMARK.pinkyMcp];
    if (!wrist || !middleMcp || !thumbTip || !indexTip || !indexMcp || !pinkyMcp) return null;

    // Tamanho da mão na imagem: normaliza tudo o mais e absorve a distância
    // do usuário até a câmera.
    const span = Math.max(distance(wrist, middleMcp), 1e-4);
    const rawRatio = distance(thumbTip, indexTip) / span;
    const ratio = this.ratio.filter(rawRatio, time);

    const pinch = this.pinchPoint.filter(
      { x: (thumbTip.x + indexTip.x) / 2, y: (thumbTip.y + indexTip.y) / 2 },
      time,
      this._out
    );
    const palm = this.palmPoint.filter(middleMcp, time, {});

    // Rotação vem do eixo indicador -> mínimo (a linha dos nós dos dedos), e
    // NÃO do vetor polegar->indicador (quase nulo com a pinça fechada, ângulo
    // vira ruído) nem do eixo punho->dedo médio (usado numa versão anterior):
    // girar o pulso em torno do próprio antebraço quase não muda ESSE vetor —
    // ele aponta na mesma direção do giro, então gira muito pouco em volta de
    // si mesmo. A linha indicador->mínimo é perpendicular ao antebraço, então
    // varre visivelmente na imagem quando o pulso gira (como girar uma maçaneta).
    const rawRoll = Math.atan2(pinkyMcp.y - indexMcp.y, pinkyMcp.x - indexMcp.x);
    if (this.lastRawRoll !== null) {
      this.unwrappedRoll += shortestAngle(rawRoll - this.lastRawRoll);
    }
    this.lastRawRoll = rawRoll;
    const roll = this.rollFilter.filter(this.unwrappedRoll, time);

    const pinching = this.gate.update(ratio, PINCH_OFF);

    return {
      present: true,
      pinching,
      pinchRatio: ratio,
      pinch: { x: pinch.x, y: pinch.y },
      palm: { x: palm.x, y: palm.y },
      roll,
      handSpan: span,
      extendedFingers: countExtendedFingers(points, wrist),
    };
  }
}

/** Mão aberta (✋) = vários dedos estendidos. Usado só para diagnóstico. */
function countExtendedFingers(points, wrist) {
  let count = 0;
  for (const finger of Object.values(FINGERS)) {
    const tip = points[finger.tip];
    const pip = points[finger.pip];
    if (!tip || !pip) continue;
    if (distance(tip, wrist) > distance(pip, wrist) * 1.15) count += 1;
  }
  return count;
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const shortestAngle = (r) => Math.atan2(Math.sin(r), Math.cos(r));
