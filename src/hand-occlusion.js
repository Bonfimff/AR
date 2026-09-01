import * as THREE from "three";
import { OneEuroVec2 } from "./filters.js";
import { LANDMARK } from "./hand/hand-analyzer.js";

/**
 * Oclusão da mão a partir dos landmarks (NÃO por profundidade medida).
 *
 * POR QUE ESTA CAMADA EXISTE
 * O depth-from-motion do ARCore assume cena estática e é preciso de 0,5 m a
 * 5 m. Uma mão diante da câmera é um objeto em movimento e quase sempre mais
 * perto que isso, então o mapa de profundidade a devolve com a distância do
 * fundo — e o equipamento é desenhado por cima dela. Ocluir atrás de objetos
 * em movimento depende de sensor ToF, que o S20 FE não tem.
 *
 * O QUE ELA É, HONESTAMENTE
 * Uma silhueta reconstruída do esqueleto rastreado, desenhada só no buffer de
 * profundidade. É aproximação baseada em rastreamento, não medição real: vale
 * para mãos, e não faz nada por pessoas ou objetos. A profundidade real
 * continua ativa por baixo, e o painel mostra as duas camadas separadamente.
 *
 * A distância é estimada pelo tamanho da mão na imagem, com a projeção da
 * câmera da AR — o que mantém a máscara coerente quando o usuário aproxima ou
 * afasta a mão, em vez de fixar um valor arbitrário.
 */

// Comprimento da palma (punho -> nó do dedo médio) de um adulto. É a régua que
// converte tamanho na imagem em distância; ajuste aqui se a máscara aparecer
// sistematicamente na frente ou atrás do que deveria.
const PALM_METERS = 0.095;
// Espessura desenhada por osso. Generosa de propósito: os landmarks ficam no
// centro do dedo, e a pele passa das bordas.
const BONE_METERS = 0.026;
const PALM_PADDING = 1.25;

// A mão NÃO tem espessura uniforme, e desenhá-la assim é o que deixava a
// silhueta com cara de boneco de palito: a palma saía fina demais (aparecia
// fundo entre os ossos que a atravessam) e as pontas dos dedos, gordas demais.
// Multiplicador por osso, relativo a BONE_METERS:
const THUMB = 1.15; // o polegar é mais grosso que os outros dedos
const TIP = 0.72; // falange distal: afina para a ponta
const MID = 0.88;
const PALM_BONE = 2.1; // ossos que cruzam a palma: preenchem a mão, não um dedo
const BONE_SCALE = [
  THUMB, THUMB, THUMB * 0.9, THUMB * TIP, // polegar
  1.0, 1.0, MID, TIP, // indicador
  1.0, MID, TIP, // médio
  0.95, MID * 0.95, TIP * 0.95, // anelar
  0.95, 0.9, MID * 0.9, TIP * 0.9, // mínimo
  PALM_BONE, PALM_BONE, PALM_BONE, // travessas da palma
];

const MIN_DISTANCE = 0.12;
const MAX_DISTANCE = 1.5;

const L = LANDMARK;
// Ossos do esqueleto do MediaPipe.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];
// O nó do polegar entra no leque: sem ele, a silhueta entalhava o músculo da
// base do polegar (a região carnuda entre polegar e indicador) e o equipamento
// reaparecia bem no meio da mão.
const PALM = [0, L.thumbMcp, L.indexMcp, L.middleMcp, L.ringMcp, L.pinkyMcp];

// A mão não termina no landmark do punho: o pulso continua. Sem esta faixa a
// silhueta afinava até um bico e o equipamento voltava a aparecer sobre o
// pulso. Fração do vão punho -> nó do dedo médio.
const WRIST_EXTENSION = 0.6;

// Onde dois ossos se encontram a direção muda, e um retângulo por osso deixa
// uma aresta viva na junta — visível de perto como um contorno poligonal em
// vez de um dedo. Um hexágono em cada junta arredonda essa transição; barato
// o bastante (6 triângulos) para cobrir todas de uma vez.
// Só as falanges distais passam da ponta; as demais emendam na próxima.
const TIP_OVERSHOOT = Object.fromEntries(
  BONES.map(([, b], i) => [i, [L.thumbTip, L.indexTip, L.middleTip, L.ringTip, L.pinkyTip].includes(b) ? 1.0 : 0])
);

// Hexágono era pouco: de perto a junta lia como um parafuso sextavado no meio
// do dedo. Doze segmentos custam 12 triângulos por junta e somem como curva.
const CAP_SEGMENTS = 12;
const JOINTS = [...new Set(BONES.flat())];

// Raio do disco de cada junta: o MAIOR entre os ossos que a tocam, para o
// disco nunca ficar mais fino que o dedo que chega nele.
const JOINT_SCALE = {};
for (let i = 0; i < BONES.length; i += 1) {
  for (const j of BONES[i]) {
    JOINT_SCALE[j] = Math.max(JOINT_SCALE[j] ?? 0, BONE_SCALE[i] ?? 1);
  }
}

// 2 triângulos por osso + um leque de PALM.length triângulos para a palma +
// um hexágono por junta.
// ... + 6 vértices do quad do pulso.
const MAX_VERTICES = BONES.length * 6 + PALM.length * 3 + JOINTS.length * CAP_SEGMENTS * 3 + 6;

export class HandOcclusion {
  constructor() {
    this.active = false;
    this.distance = 0;

    this.positions = new Float32Array(MAX_VERTICES * 3);
    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.attribute);

    this.uniforms = { fragDepth: { value: 1 }, debug: { value: 0 } };

    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: this.uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        // LessDepth, e não Always: a máscara só vence onde estiver realmente
        // mais perto do que já foi escrito. Assim ela compõe com a oclusão por
        // profundidade real em vez de atropelá-la.
        depthTest: true,
        depthFunc: THREE.LessDepth,
        depthWrite: true,
        colorWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1e9; // depois do passe de profundidade, antes da cena
    this.mesh.visible = false;
    this.mesh.name = "HandOcclusion";

    // Suaviza cada landmark. Também interpola entre inferências: o MediaPipe
    // roda a ~12 Hz e a cena a 60, então sem isto a máscara andaria aos saltos.
    this.filters = Array.from({ length: 21 }, () => new OneEuroVec2({ minCutoff: 2.5, beta: 0.05 }));
    this.smoothed = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  }

  setDebug(on) {
    this.uniforms.debug.value = on ? 1 : 0;
    this.mesh.material.colorWrite = Boolean(on);
    this.mesh.material.transparent = Boolean(on);
    this.mesh.material.needsUpdate = true;
  }

  reset() {
    for (const filter of this.filters) filter.reset();
    this.active = false;
    this.mesh.visible = false;
  }

  /**
   * @param {Array<{x,y}>|null} points landmarks em [0..1], origem no topo-esq.
   * @param {THREE.Camera} camera câmera do XR (dá a projeção)
   * @param {number} aspect largura/altura do viewport
   * @param {number} time segundos
   */
  update(points, camera, aspect, time) {
    this.active = false;
    this.mesh.visible = false;
    if (!points || !camera || !aspect) return;

    const wrist = points[L.wrist];
    const middleMcp = points[L.middleMcp];
    if (!wrist || !middleMcp) return;

    for (let i = 0; i < 21; i += 1) {
      const point = points[i];
      if (point) this.filters[i].filter(point, time, this.smoothed[i]);
    }

    const projection = camera.projectionMatrix.elements;
    const focal = projection[5]; // = 1 / tan(fovY / 2)

    // Tamanho da palma na imagem, em unidades verticais equivalentes.
    const dx = (this.smoothed[L.wrist].x - this.smoothed[L.middleMcp].x) * aspect;
    const dy = this.smoothed[L.wrist].y - this.smoothed[L.middleMcp].y;
    const spanFraction = Math.hypot(dx, dy);
    if (spanFraction < 1e-4) return;

    this.distance = THREE.MathUtils.clamp(
      (PALM_METERS * focal) / (2 * spanFraction),
      MIN_DISTANCE,
      MAX_DISTANCE
    );

    // Metros -> profundidade em NDC, com a projeção da própria câmera da AR.
    const viewZ = -this.distance;
    const clipZ = projection[10] * viewZ + projection[14];
    this.uniforms.fragDepth.value = THREE.MathUtils.clamp((clipZ / -viewZ) * 0.5 + 0.5, 0, 1);

    const halfWidth = (BONE_METERS * focal) / (2 * this.distance); // em NDC vertical
    this.build(halfWidth, aspect);

    this.mesh.visible = true;
    this.active = true;
  }

  /** Monta a silhueta: um quad por osso, um hexágono por junta, e o leque da palma. */
  build(halfWidth, aspect) {
    const positions = this.positions;
    let n = 0;

    const push = (x, y) => {
      positions[n] = x;
      positions[n + 1] = y;
      positions[n + 2] = 0;
      n += 3;
    };
    // Landmark -> NDC. O Y dos landmarks cresce para baixo; o do NDC, para cima.
    const ndcX = (i) => this.smoothed[i].x * 2 - 1;
    const ndcY = (i) => 1 - this.smoothed[i].y * 2;

    for (let bone = 0; bone < BONES.length; bone += 1) {
      const [a, b] = BONES[bone];
      const width = halfWidth * (BONE_SCALE[bone] ?? 1);
      // Perpendicular calculada em espaço corrigido pelo aspecto, para a
      // espessura ficar uniforme na tela e não achatada num dos eixos.
      const ax = ndcX(a) * aspect;
      const ay = ndcY(a);
      const bx = ndcX(b) * aspect;
      const by = ndcY(b);
      const length = Math.hypot(bx - ax, by - ay) || 1;
      const px = (-(by - ay) / length) * width;
      const py = ((bx - ax) / length) * width;

      // A ponta do dedo continua além do landmark, que fica no centro da polpa.
      // Sem esta sobra a máscara termina no meio da unha e o equipamento
      // reaparece por cima da ponta do dedo.
      const overshoot = TIP_OVERSHOOT[bone] ?? 0;
      const ex = ((bx - ax) / length) * width * overshoot;
      const ey = ((by - ay) / length) * width * overshoot;

      const p1 = [(ax + px) / aspect, ay + py];
      const p2 = [(bx + px + ex) / aspect, by + py + ey];
      const p3 = [(bx - px + ex) / aspect, by - py + ey];
      const p4 = [(ax - px) / aspect, ay - py];

      push(p1[0], p1[1]); push(p2[0], p2[1]); push(p3[0], p3[1]);
      push(p1[0], p1[1]); push(p3[0], p3[1]); push(p4[0], p4[1]);
    }

    // Faixa do pulso: prolonga a mão para além do landmark 0, na direção
    // oposta aos dedos, com a largura da palma.
    {
      const wx = ndcX(L.wrist) * aspect;
      const wy = ndcY(L.wrist);
      const mx = ndcX(L.middleMcp) * aspect;
      const my = ndcY(L.middleMcp);
      const span = Math.hypot(wx - mx, wy - my) || 1;
      const dx = ((wx - mx) / span) * span * WRIST_EXTENSION;
      const dy = ((wy - my) / span) * span * WRIST_EXTENSION;

      const ix = ndcX(L.indexMcp) * aspect;
      const iy = ndcY(L.indexMcp);
      const px = ndcX(L.pinkyMcp) * aspect;
      const py = ndcY(L.pinkyMcp);
      const across = Math.hypot(px - ix, py - iy) || 1;
      const nx = ((-(wy - my) / span) * across) / 2;
      const ny = (((wx - mx) / span) * across) / 2;

      const a1 = [(wx + nx) / aspect, wy + ny];
      const a2 = [(wx - nx) / aspect, wy - ny];
      const b1 = [(wx + nx + dx) / aspect, wy + ny + dy];
      const b2 = [(wx - nx + dx) / aspect, wy - ny + dy];
      push(a1[0], a1[1]); push(b1[0], b1[1]); push(b2[0], b2[1]);
      push(a1[0], a1[1]); push(b2[0], b2[1]); push(a2[0], a2[1]);
    }

    // Um hexágono do raio dos ossos em cada junta, arredondando a transição
    // entre segmentos consecutivos.
    for (const j of JOINTS) {
      const jx = ndcX(j);
      const jy = ndcY(j);
      const ax = jx * aspect; // mesmo espaço corrigido por aspecto dos ossos
      // O disco acompanha a espessura de quem chega na junta: um disco de
      // tamanho único voltaria a engordar as pontas dos dedos.
      const radius = halfWidth * (JOINT_SCALE[j] ?? 1);
      for (let s = 0; s < CAP_SEGMENTS; s += 1) {
        const a0 = (s / CAP_SEGMENTS) * Math.PI * 2;
        const a1 = ((s + 1) / CAP_SEGMENTS) * Math.PI * 2;
        const x0 = (ax + Math.cos(a0) * radius) / aspect;
        const y0 = jy + Math.sin(a0) * radius;
        const x1 = (ax + Math.cos(a1) * radius) / aspect;
        const y1 = jy + Math.sin(a1) * radius;
        push(jx, jy); push(x0, y0); push(x1, y1);
      }
    }

    // Palma: leque a partir do centroide, levemente dilatado.
    let cx = 0;
    let cy = 0;
    for (const i of PALM) {
      cx += ndcX(i);
      cy += ndcY(i);
    }
    cx /= PALM.length;
    cy /= PALM.length;
    const grow = (i) => [
      cx + (ndcX(i) - cx) * PALM_PADDING,
      cy + (ndcY(i) - cy) * PALM_PADDING,
    ];
    for (let i = 1; i < PALM.length; i += 1) {
      const a = grow(PALM[i - 1]);
      const b = grow(PALM[i]);
      push(cx, cy); push(a[0], a[1]); push(b[0], b[1]);
    }
    const first = grow(PALM[0]);
    const last = grow(PALM[PALM.length - 1]);
    push(cx, cy); push(last[0], last[1]); push(first[0], first[1]);

    this.attribute.needsUpdate = true;
    this.geometry.setDrawRange(0, n / 3);
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
    this.active = false;
  }
}

const VERTEX = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform float fragDepth;
uniform float debug;
out vec4 fragColor;

void main() {
  gl_FragDepth = fragDepth;
  fragColor = debug > 0.5 ? vec4(0.0, 0.85, 1.0, 0.45) : vec4(0.0);
}
`;
