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

// Apontar (👉): indicador esticado com médio, anelar e mínimo recolhidos.
// Medido como razão entre a distância ponta->punho e junta->punho, então
// vale igual com a mão perto ou longe da câmera, como os limiares da pinça.
//
// A folga entre os dois limiares é o que separa o gesto de uma mão relaxada:
// o indicador precisa estar CLARAMENTE esticado (1,25) e os outros CLARAMENTE
// dobrados (1,02), senão qualquer mão meio aberta viraria um toque acidental.
// O polegar fica de fora de propósito — apontar com o polegar colado ou
// levantado é indiferente, e exigir uma das duas formas só geraria falha.
const POINT_INDEX_MIN = 1.25;
const POINT_OTHERS_MAX = 1.02;

// Frames consecutivos para ligar/desligar. O gesto dispara UMA ação por vez,
// então um falso positivo custa caro (abrir a porta sem querer) — daí exigir
// mais confirmação para entrar do que para sair.
const POINT_FRAMES_ON = 4;
const POINT_FRAMES_OFF = 2;

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
    // Mira do gesto de apontar: a ponta do indicador, filtrada. Sem filtro, o
    // tremor da mão faz o raio varrer vários centímetros no equipamento.
    this.indexPoint = new OneEuroVec2({ minCutoff: 1.2, beta: 0.02 });
    this.pointing = false;
    this.pointStreak = 0;
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
    this.indexPoint.reset();
    this.pointing = false;
    this.pointStreak = 0;
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

    // Apontar nunca coexiste com pinça: na pinça o indicador está dobrado
    // contra o polegar, então a checagem abaixo já falharia — mas negar aqui
    // deixa a exclusão explícita em vez de acidental.
    const wantsPoint = !pinching && isPointingPose(points, wrist);
    if (wantsPoint === this.pointing) {
      this.pointStreak = 0;
    } else if (++this.pointStreak >= (this.pointing ? POINT_FRAMES_OFF : POINT_FRAMES_ON)) {
      this.pointing = wantsPoint;
      this.pointStreak = 0;
    }
    const aim = this.indexPoint.filter(indexTip, time, {});

    return {
      present: true,
      pinching,
      pinchRatio: ratio,
      pinch: { x: pinch.x, y: pinch.y },
      palm: { x: palm.x, y: palm.y },
      roll,
      handSpan: span,
      pointing: this.pointing,
      indexTip: { x: aim.x, y: aim.y },
      extendedFingers: countExtendedFingers(points, wrist),
    };
  }
}

/** Quanto o dedo está esticado: >1 afasta a ponta do punho mais que a junta. */
function extension(points, wrist, finger) {
  const tip = points[finger.tip];
  const pip = points[finger.pip];
  if (!tip || !pip) return 0;
  return distance(tip, wrist) / Math.max(distance(pip, wrist), 1e-4);
}

/** 👉 indicador esticado, os outros três recolhidos. */
function isPointingPose(points, wrist) {
  if (extension(points, wrist, FINGERS.indicador) < POINT_INDEX_MIN) return false;
  return [FINGERS.medio, FINGERS.anelar, FINGERS.minimo].every(
    (finger) => extension(points, wrist, finger) < POINT_OTHERS_MAX
  );
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
