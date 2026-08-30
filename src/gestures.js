import * as THREE from "three";

/**
 * Manipulação do objeto por touchscreen (sem visão computacional).
 *
 * Os eventos vêm da camada do dom-overlay: durante uma sessão immersive-ar o
 * canvas WebGL não recebe eventos de ponteiro.
 *
 *   toque curto      -> onTap(x, y)  (colocar / selecionar / desselecionar)
 *   1 dedo, arrastar -> move sobre o plano horizontal do objeto
 *   2 dedos          -> UM modo por vez: escala, rotação OU altura
 *
 * A arbitragem de dois dedos é deliberada: aplicar escala, giro e altura ao
 * mesmo tempo torna o gesto imprevisível. O primeiro eixo que cruza seu limiar
 * "trava" o modo até os dedos saírem da tela.
 */

export const LIMITS = {
  minScale: 0.2, // múltiplos do tamanho natural do modelo
  maxScale: 5,
  minHeight: -0.5, // metros em relação à superfície detectada
  maxHeight: 2,
  maxRadius: 5, // deslocamento horizontal máximo a partir da âncora (m)
};

const TAP_MAX_MS = 300;
const TAP_MAX_PX = 12;

// Limiares de arbitragem: quanto o gesto precisa andar para definir o modo.
const SCALE_THRESHOLD = 0.1; // variação relativa da distância entre os dedos
const ROTATE_THRESHOLD = 0.18; // radianos (~10°)
const HEIGHT_THRESHOLD_PX = 26;

// O vencedor precisa superar o segundo colocado por esta margem, não só
// cruzar o próprio limiar primeiro — evita travar em altura por causa de um
// pan levemente diagonal, ou em escala por causa de um giro impreciso.
const DOMINANCE_MARGIN = 1.3;

// O touchscreen entrega um pointermove POR DEDO. Enquanto só um dedo se moveu,
// o par parece estar girando, e classificar aí travaria o modo errado. Por isso
// só classificamos quando os dois dedos já andaram — ou quando um andou muito
// com o outro parado, caso em que "pan" é impossível e a altura sai do páreo.
const CLASSIFY_MIN_PX = 14;
const ANCHORED_MIN_PX = 90;
const ANCHORED_STILL_PX = 8;

// Arrastar a altura da tela inteira equivale a 1,5 m — sensibilidade previsível
// em qualquer resolução, sem saltos absurdos com movimentos pequenos.
const HEIGHT_TRAVEL_METERS = 1.5;

const SMOOTHING = 18; // maior = resposta mais direta

const _worldPosition = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _ndc = new THREE.Vector2();

export class GestureController {
  constructor({ element, getCamera, onTap, onChange, onModeChange }) {
    this.element = element;
    this.getCamera = getCamera;
    this.onTap = onTap;
    this.onChange = onChange;
    this.onModeChange = onModeChange;

    this.target = null;
    this.pointers = new Map();
    this.mode = null; // 'drag' | 'two-finger'
    this.subMode = null; // 'scale' | 'rotate' | 'height'
    this.tapCandidate = null;

    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane();
    this.dragOffset = new THREE.Vector3();
    this.start = null;

    // Valores desejados; o update() aproxima o objeto deles suavemente.
    this.desired = { scale: 1, rotationY: 0, height: 0 };

    this._down = this.onPointerDown.bind(this);
    this._move = this.onPointerMove.bind(this);
    this._up = this.onPointerUp.bind(this);

    element.addEventListener("pointerdown", this._down);
    element.addEventListener("pointermove", this._move);
    element.addEventListener("pointerup", this._up);
    element.addEventListener("pointercancel", this._up);
  }

  /** Define o objeto manipulável (null = nada selecionado). */
  setTarget(object) {
    this.target = object;
    this.pointers.clear();
    this.mode = null;
    this.subMode = null;
    if (object) {
      this.desired.scale = object.scale.x;
      this.desired.rotationY = object.rotation.y;
      this.desired.height = object.position.y;
    }
  }

  /** Escala vinda do controle na tela (ver ARExperience.setScale). */
  setScale(scale) {
    this.desired.scale = scale;
    if (this.start) this.start.scale = scale;
  }

  dispose() {
    this.element.removeEventListener("pointerdown", this._down);
    this.element.removeEventListener("pointermove", this._move);
    this.element.removeEventListener("pointerup", this._up);
    this.element.removeEventListener("pointercancel", this._up);
    this.pointers.clear();
    this.target = null;
  }

  /** Chamado a cada frame: suaviza escala, rotação e altura. */
  update(delta) {
    if (!this.target) return;
    const t = 1 - Math.exp(-SMOOTHING * delta);
    const object = this.target;

    // O clamp é reaplicado aqui para que os limites valham para o estado final
    // do objeto, e não apenas para o ponto em que o gesto os calculou.
    object.scale.setScalar(
      THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(object.scale.x, this.desired.scale, t),
        LIMITS.minScale,
        LIMITS.maxScale
      )
    );
    object.rotation.y = THREE.MathUtils.lerp(object.rotation.y, this.desired.rotationY, t);
    object.position.y = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(object.position.y, this.desired.height, t),
      LIMITS.minHeight,
      LIMITS.maxHeight
    );
  }

  // ---- ponteiros ----

  onPointerDown(event) {
    capture(this.element, event.pointerId, true);
    this.pointers.set(event.pointerId, readPoint(event));

    if (this.pointers.size === 1) {
      this.tapCandidate = { time: performance.now(), ...readPoint(event) };
      if (this.target) this.beginDrag(event.clientX, event.clientY);
    } else if (this.pointers.size === 2 && this.target) {
      this.tapCandidate = null;
      this.beginTwoFinger();
    }
  }

  onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const point = readPoint(event);
    this.pointers.set(event.pointerId, point);

    if (this.tapCandidate && distance(this.tapCandidate, point) > TAP_MAX_PX) {
      this.tapCandidate = null;
    }
    if (!this.target) return;

    if (this.mode === "drag" && this.pointers.size === 1) {
      this.updateDrag(event.clientX, event.clientY);
    } else if (this.mode === "two-finger" && this.pointers.size === 2) {
      this.updateTwoFinger();
    }
  }

  onPointerUp(event) {
    capture(this.element, event.pointerId, false);
    this.pointers.delete(event.pointerId);

    const tap = this.tapCandidate;
    if (tap && this.pointers.size === 0 && performance.now() - tap.time < TAP_MAX_MS) {
      this.tapCandidate = null;
      this.onTap?.(tap.x, tap.y);
    }

    if (this.pointers.size === 0) {
      this.mode = null;
      this.subMode = null;
      this.onModeChange?.(null);
    } else if (this.pointers.size === 1 && this.target) {
      // Voltou a um dedo: recomeça o arrasto sem salto. O rótulo do modo
      // anterior (escala/giro/altura) some até o arrasto ser confirmado de
      // novo, para não ficar exibindo um gesto que já não está mais ativo.
      this.onModeChange?.(null);
      const [remaining] = this.pointers.values();
      this.beginDrag(remaining.x, remaining.y);
    }
  }

  // ---- um dedo: mover sobre o plano horizontal ----

  beginDrag(clientX, clientY) {
    this.mode = "drag";
    this.subMode = null;
    this._dragAnnounced = false; // só avisa "movendo" quando o arrasto for real, não num toque
    this.target.getWorldPosition(_worldPosition);
    this.plane.setFromNormalAndCoplanarPoint(THREE.Object3D.DEFAULT_UP, _worldPosition);
    const hit = this.rayToPlane(clientX, clientY);
    if (hit) this.dragOffset.copy(_worldPosition).sub(hit);
    else this.dragOffset.set(0, 0, 0);
  }

  updateDrag(clientX, clientY) {
    const hit = this.rayToPlane(clientX, clientY);
    if (!hit) return;

    if (!this._dragAnnounced) {
      this._dragAnnounced = true;
      this.onModeChange?.("move");
    }

    hit.add(this.dragOffset);
    const local = this.target.parent.worldToLocal(hit);

    // Mantém a altura sob controle do gesto de altura, não do arrasto.
    const radius = Math.hypot(local.x, local.z);
    if (radius > LIMITS.maxRadius) {
      const k = LIMITS.maxRadius / radius;
      local.x *= k;
      local.z *= k;
    }
    this.target.position.x = local.x;
    this.target.position.z = local.z;
    this.onChange?.();
  }

  // ---- dois dedos: escala OU rotação OU altura ----

  beginTwoFinger() {
    this.mode = "two-finger";
    this.subMode = null;
    this.onModeChange?.(null); // some o rótulo de "mover" até o segundo modo ser decidido
    const [[idA, a], [idB, b]] = this.pointers.entries();
    this.start = {
      idA,
      idB,
      a: { ...a },
      b: { ...b },
      distance: distance(a, b) || 1,
      angle: angleOf(a, b),
      centerY: (a.y + b.y) / 2,
      scale: this.desired.scale,
      rotationY: this.desired.rotationY,
      height: this.desired.height,
    };
  }

  updateTwoFinger() {
    const a = this.pointers.get(this.start.idA);
    const b = this.pointers.get(this.start.idB);
    if (!a || !b) return;

    const currentDistance = distance(a, b) || 1;
    const currentAngle = angleOf(a, b);
    const centerY = (a.y + b.y) / 2;

    if (this.subMode === null) {
      if (!this.classify(a, b, currentDistance, currentAngle, centerY)) return;
      return;
    }

    const deltaY = centerY - this.start.centerY;

    if (this.subMode === "scale") {
      this.desired.scale = THREE.MathUtils.clamp(
        this.start.scale * (currentDistance / this.start.distance),
        LIMITS.minScale,
        LIMITS.maxScale
      );
    } else if (this.subMode === "rotate") {
      this.desired.rotationY =
        this.start.rotationY + shortestAngle(currentAngle - this.start.angle);
    } else {
      const meters = (deltaY / this.element.clientHeight) * HEIGHT_TRAVEL_METERS;
      this.desired.height = THREE.MathUtils.clamp(
        this.start.height - meters, // arrastar para cima sobe o objeto
        LIMITS.minHeight,
        LIMITS.maxHeight
      );
    }
    this.onChange?.();
  }

  /**
   * Escolhe UM modo para os dois dedos. Retorna true quando o modo foi definido.
   * Usa o deslocamento de cada dedo desde o início do gesto, não o estado
   * instantâneo do par — é isso que evita classificar um pan como rotação.
   */
  classify(a, b, currentDistance, currentAngle, centerY) {
    const movedA = distance(a, this.start.a);
    const movedB = distance(b, this.start.b);

    let allowHeight = true;
    if (Math.min(movedA, movedB) < CLASSIFY_MIN_PX) {
      const anchored =
        Math.max(movedA, movedB) >= ANCHORED_MIN_PX &&
        Math.min(movedA, movedB) <= ANCHORED_STILL_PX;
      if (!anchored) return false; // ainda cedo para decidir
      allowHeight = false; // um dedo parado: não existe pan, só pinça ou giro
    }

    const panX = (a.x - this.start.a.x + (b.x - this.start.b.x)) / 2;
    const panY = (a.y - this.start.a.y + (b.y - this.start.b.y)) / 2;

    const scaleProgress = Math.abs(currentDistance / this.start.distance - 1) / SCALE_THRESHOLD;
    const rotateProgress =
      Math.abs(shortestAngle(currentAngle - this.start.angle)) / ROTATE_THRESHOLD;
    const heightProgress =
      allowHeight && Math.abs(panY) > Math.abs(panX)
        ? Math.abs(panY) / HEIGHT_THRESHOLD_PX
        : 0;

    const candidates = [
      { mode: "scale", progress: scaleProgress },
      { mode: "rotate", progress: rotateProgress },
      { mode: "height", progress: heightProgress },
    ].sort((a, b) => b.progress - a.progress);
    const [best, runnerUp] = candidates;
    if (best.progress < 1 || best.progress < runnerUp.progress * DOMINANCE_MARGIN) return false;

    this.subMode = best.mode;

    // Rebaseia no ponto atual para o modo não começar com um salto.
    this.start.a = { ...a };
    this.start.b = { ...b };
    this.start.distance = currentDistance;
    this.start.angle = currentAngle;
    this.start.centerY = centerY;
    this.onModeChange?.(this.subMode);
    return true;
  }

  // ---- utilitários ----

  rayToPlane(clientX, clientY) {
    const camera = this.getCamera();
    if (!camera) return null;
    const rect = this.element.getBoundingClientRect();
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(_ndc, camera);
    return this.raycaster.ray.intersectPlane(this.plane, _hitPoint) ? _hitPoint : null;
  }
}

// Alguns navegadores lançam ao capturar/liberar um ponteiro já encerrado.
function capture(element, pointerId, on) {
  try {
    if (on) element.setPointerCapture?.(pointerId);
    else element.releasePointerCapture?.(pointerId);
  } catch {
    /* ponteiro já não está ativo */
  }
}

const readPoint = (event) => ({ x: event.clientX, y: event.clientY });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const shortestAngle = (radians) => Math.atan2(Math.sin(radians), Math.cos(radians));
