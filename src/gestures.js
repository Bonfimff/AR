import * as THREE from "three";

const TAP_MAX_MS = 300;
const TAP_MAX_PX = 12;
const HEIGHT_SENSITIVITY = 0.0025; // metros por pixel
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

/**
 * Gestos de toque sobre o objeto já colocado.
 * Os eventos vêm da camada DOM overlay: durante uma sessão immersive-ar o
 * canvas WebGL não recebe eventos de ponteiro.
 *
 *  1 dedo  -> arrasta sobre o plano horizontal do objeto
 *  2 dedos -> pinça (escala), giro (rotação em Y), deslize vertical (altura)
 *  toque curto sem objeto colocado -> onTap()
 */
export class GestureController {
  constructor({ element, getCamera, onTap }) {
    this.element = element;
    this.getCamera = getCamera;
    this.onTap = onTap;
    this.target = null;

    this.pointers = new Map();
    this.mode = null;
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane();
    this.dragOffset = new THREE.Vector3();
    this.start = null;

    this._down = this.onPointerDown.bind(this);
    this._move = this.onPointerMove.bind(this);
    this._up = this.onPointerUp.bind(this);

    element.addEventListener("pointerdown", this._down);
    element.addEventListener("pointermove", this._move);
    element.addEventListener("pointerup", this._up);
    element.addEventListener("pointercancel", this._up);
  }

  setTarget(object) {
    this.target = object;
    this.pointers.clear();
    this.mode = null;
  }

  dispose() {
    this.element.removeEventListener("pointerdown", this._down);
    this.element.removeEventListener("pointermove", this._move);
    this.element.removeEventListener("pointerup", this._up);
    this.element.removeEventListener("pointercancel", this._up);
    this.pointers.clear();
    this.target = null;
  }

  onPointerDown(event) {
    this.element.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, point(event));

    if (this.pointers.size === 1) {
      this.tapCandidate = { time: performance.now(), ...point(event) };
      if (this.target) this.beginDrag(event);
    } else if (this.pointers.size === 2 && this.target) {
      this.tapCandidate = null;
      this.beginTwoFinger();
    }
  }

  onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, point(event));

    if (this.tapCandidate && dist(this.tapCandidate, point(event)) > TAP_MAX_PX) {
      this.tapCandidate = null;
    }
    if (!this.target) return;

    if (this.mode === "drag" && this.pointers.size === 1) {
      const hit = this.rayToPlane(event.clientX, event.clientY);
      if (hit) {
        hit.add(this.dragOffset);
        this.target.position.copy(this.target.parent.worldToLocal(hit));
      }
    } else if (this.mode === "two-finger" && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];

      const scale = THREE.MathUtils.clamp(
        this.start.scale * (dist(a, b) / this.start.distance),
        MIN_SCALE,
        MAX_SCALE
      );
      this.target.scale.setScalar(scale);

      this.target.rotation.y = this.start.rotationY + (angle(a, b) - this.start.angle);

      const dy = (a.y + b.y) / 2 - this.start.centerY;
      this.target.position.y = this.start.height - dy * HEIGHT_SENSITIVITY;
    }
  }

  onPointerUp(event) {
    this.element.releasePointerCapture?.(event.pointerId);
    this.pointers.delete(event.pointerId);

    if (
      this.tapCandidate &&
      this.pointers.size === 0 &&
      performance.now() - this.tapCandidate.time < TAP_MAX_MS
    ) {
      this.tapCandidate = null;
      if (!this.target) this.onTap?.();
    }

    if (this.pointers.size === 0) {
      this.mode = null;
    } else if (this.pointers.size === 1 && this.target) {
      const [remaining] = this.pointers.values();
      this.beginDrag({ clientX: remaining.x, clientY: remaining.y });
    }
  }

  beginDrag(event) {
    this.mode = "drag";
    const worldPosition = this.target.getWorldPosition(new THREE.Vector3());
    this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), worldPosition);
    const hit = this.rayToPlane(event.clientX, event.clientY);
    this.dragOffset.copy(hit ? worldPosition.clone().sub(hit) : new THREE.Vector3());
  }

  beginTwoFinger() {
    this.mode = "two-finger";
    const [a, b] = [...this.pointers.values()];
    this.start = {
      distance: dist(a, b) || 1,
      angle: angle(a, b),
      centerY: (a.y + b.y) / 2,
      scale: this.target.scale.x,
      rotationY: this.target.rotation.y,
      height: this.target.position.y,
    };
  }

  rayToPlane(clientX, clientY) {
    const camera = this.getCamera();
    if (!camera) return null;
    const rect = this.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.plane, out) ? out : null;
  }
}

const point = (event) => ({ x: event.clientX, y: event.clientY });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
