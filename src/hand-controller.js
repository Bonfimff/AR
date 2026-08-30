import * as THREE from "three";
import { HandAnalyzer } from "./hand/hand-analyzer.js";
import { ScreenRay } from "./ray-plane.js";
import { LIMITS } from "./gestures.js";

/**
 * Máquina de estados do controle por mão.
 *
 *   IDLE -> HAND_DETECTED -> PINCH_DETECTED -> OBJECT_SELECTED
 *        -> MANIPULATING -> RELEASED -> IDLE
 *
 * Toda a decisão de gesto está aqui; os providers só entregam landmarks e o
 * analisador só entrega sinais filtrados. Nada de lógica de gesto espalhada.
 */
export const HAND_STATE = {
  IDLE: "IDLE",
  HAND_DETECTED: "HAND_DETECTED",
  PINCH_DETECTED: "PINCH_DETECTED",
  OBJECT_SELECTED: "OBJECT_SELECTED",
  MANIPULATING: "MANIPULATING",
  RELEASED: "RELEASED",
};

// Limiares de arbitragem, em fração do viewport / radianos / razão de pinça.
// Mesmo princípio já validado no toque: UM modo por manipulação.
const MOVE_THRESHOLD = 0.045;
const HEIGHT_THRESHOLD = 0.055;
const ROLL_THRESHOLD = 0.3;
const RATIO_THRESHOLD = 0.18;

// Não basta o candidato vencedor cruzar seu limiar: ele precisa vencer o
// segundo colocado por esta margem. Sem isto, um gesto na diagonal (que anda
// um pouco em X e em Y ao mesmo tempo) podia travar em "mover" quando a
// intenção era "altura", só porque um cruzou o limiar um instante antes do
// outro. É o mesmo problema, em outras palavras, que fazia escala e
// deslocamento se confundirem.
const DOMINANCE_MARGIN = 1.3;

// Subir a mão pela altura inteira da tela equivale a 1,5 m de altura.
const HEIGHT_TRAVEL_METERS = 1.5;
const SMOOTHING = 12;

// Ao fechar a pinça os filtros ainda estão convergindo. Sem esta carência, a
// variação residual da razão polegar-indicador era classificada como gesto de
// escala antes de o usuário mover qualquer coisa — escala involuntária.
const GRAB_SETTLE_SECONDS = 0.25;

export class HandController {
  constructor({ getCamera, getRect, onStateChange, onModeChange }) {
    this.getCamera = getCamera;
    this.getRect = getRect;
    this.onStateChange = onStateChange;
    this.onModeChange = onModeChange;

    this.analyzer = new HandAnalyzer();
    this.ray = new ScreenRay();
    this.state = HAND_STATE.IDLE;
    this.mode = null;
    this.lastTime = 0;
    this.target = null;
    this.grab = null;
    this.sample = null;
    this.enabled = true;

    this.desired = { scale: 1, rotationY: 0, height: 0 };
    this._world = new THREE.Vector3();
  }

  setTarget(object) {
    this.target = object;
    this.syncDesired();
  }

  syncDesired() {
    if (!this.target) return;
    this.desired.scale = this.target.scale.x;
    this.desired.rotationY = this.target.rotation.y;
    this.desired.height = this.target.position.y;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  get manipulating() {
    return this.state === HAND_STATE.MANIPULATING || this.state === HAND_STATE.OBJECT_SELECTED;
  }

  /**
   * @param {Array|null} points landmarks em [0..1], ou null se não há mão
   * @param {number} time segundos
   * @param {number} delta segundos desde o último frame
   */
  update(points, time, delta) {
    if (!this.enabled || !points) {
      if (this.grab) this.release();
      this.analyzer.reset();
      this.sample = null;
      this.setState(HAND_STATE.IDLE);
      return;
    }

    this.lastTime = time;
    const sample = this.analyzer.analyze(points, time, this.mode === "scale");
    this.sample = sample;
    if (!sample) {
      this.setState(HAND_STATE.IDLE);
      return;
    }

    if (!this.grab) {
      this.setState(sample.pinching ? HAND_STATE.PINCH_DETECTED : HAND_STATE.HAND_DETECTED);
      if (sample.pinching) this.tryGrab(sample);
    } else if (!sample.pinching) {
      // Abriu a mão: o objeto para exatamente onde está.
      this.release();
    } else {
      this.manipulate(sample, time);
    }

    this.applyDamping(delta);
  }

  tryGrab(sample) {
    if (!this.target) return;
    const rect = this.getRect();
    const camera = this.getCamera();
    const x = sample.pinch.x * rect.width + rect.left;
    const y = sample.pinch.y * rect.height + rect.top;

    // Só pega o equipamento se a pinça estiver de fato sobre ele.
    const grabPoint = this.ray.firstHit(x, y, camera, rect, this.target);
    if (!grabPoint) return;

    this.syncDesired();
    this.target.getWorldPosition(this._world);

    // Plano de arrasto na altura do ponto agarrado: garante que o raio da mão
    // sempre o intercepte, inclusive ao pegar o topo de um equipamento alto.
    this.ray.setHorizontalPlaneAt(grabPoint);
    const hit = this.ray.intersect(x, y, camera, rect);

    this.grab = {
      pinch: { ...sample.pinch },
      ratio: sample.pinchRatio,
      roll: sample.roll,
      scale: this.desired.scale,
      rotationY: this.desired.rotationY,
      height: this.desired.height,
      offset: hit ? this._world.clone().sub(hit) : new THREE.Vector3(),
      settleUntil: this.lastTime + GRAB_SETTLE_SECONDS,
    };
    this.mode = null;
    this.setState(HAND_STATE.OBJECT_SELECTED);
    this.onModeChange?.("selected");
  }

  manipulate(sample, time) {
    // Carência: rebaseia enquanto os sinais assentam, sem classificar nada.
    if (this.mode === null && time < this.grab.settleUntil) {
      this.grab.pinch = { ...sample.pinch };
      this.grab.ratio = sample.pinchRatio;
      this.grab.roll = sample.roll;
      return;
    }

    const dx = sample.pinch.x - this.grab.pinch.x;
    const dy = sample.pinch.y - this.grab.pinch.y;

    if (this.mode === null) {
      const moveProgress = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) / MOVE_THRESHOLD : 0;
      const heightProgress = Math.abs(dy) > Math.abs(dx) ? Math.abs(dy) / HEIGHT_THRESHOLD : 0;
      const rollProgress = Math.abs(sample.roll - this.grab.roll) / ROLL_THRESHOLD;
      const ratioProgress =
        Math.abs(sample.pinchRatio / this.grab.ratio - 1) / RATIO_THRESHOLD;

      const candidates = [
        { mode: "move", progress: moveProgress },
        { mode: "height", progress: heightProgress },
        { mode: "rotate", progress: rollProgress },
        { mode: "scale", progress: ratioProgress },
      ].sort((a, b) => b.progress - a.progress);
      const [best, runnerUp] = candidates;

      // Precisa ter cruzado o limiar E vencer o segundo colocado com folga —
      // as duas condições, não só a primeira.
      if (best.progress < 1 || best.progress < runnerUp.progress * DOMINANCE_MARGIN) return;

      this.mode = best.mode;

      // Rebaseia para o modo não começar com um salto.
      this.grab.pinch = { ...sample.pinch };
      this.grab.ratio = sample.pinchRatio;
      this.grab.roll = sample.roll;
      this.setState(HAND_STATE.MANIPULATING);
      this.onModeChange?.(this.mode);
      return;
    }

    const rect = this.getRect();
    const camera = this.getCamera();

    if (this.mode === "move") {
      const x = sample.pinch.x * rect.width + rect.left;
      const y = sample.pinch.y * rect.height + rect.top;
      const hit = this.ray.intersect(x, y, camera, rect);
      if (hit) {
        const local = this.target.parent.worldToLocal(hit.clone().add(this.grab.offset));
        const radius = Math.hypot(local.x, local.z);
        if (radius > LIMITS.maxRadius) {
          const k = LIMITS.maxRadius / radius;
          local.x *= k;
          local.z *= k;
        }
        this.target.position.x = local.x;
        this.target.position.z = local.z;
      }
    } else if (this.mode === "height") {
      const meters = (sample.pinch.y - this.grab.pinch.y) * HEIGHT_TRAVEL_METERS;
      this.desired.height = THREE.MathUtils.clamp(
        this.grab.height - meters, // mão sobe (y diminui) => objeto sobe
        LIMITS.minHeight,
        LIMITS.maxHeight
      );
    } else if (this.mode === "rotate") {
      this.desired.rotationY = this.grab.rotationY + (sample.roll - this.grab.roll);
    } else if (this.mode === "scale") {
      this.desired.scale = THREE.MathUtils.clamp(
        this.grab.scale * (sample.pinchRatio / this.grab.ratio),
        LIMITS.minScale,
        LIMITS.maxScale
      );
    }
  }

  release() {
    this.grab = null;
    this.mode = null;
    this.syncDesired(); // congela o transform atual como alvo: nada mais se move
    this.setState(HAND_STATE.RELEASED);
    this.onModeChange?.(null);
  }

  applyDamping(delta) {
    if (!this.target || !this.grab) return;
    const t = 1 - Math.exp(-SMOOTHING * delta);
    const object = this.target;

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

  dispose() {
    this.analyzer.reset();
    this.target = null;
    this.grab = null;
  }
}
