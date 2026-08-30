import * as THREE from "three";

/**
 * Vista explodida: separa as peças do equipamento ao longo da direção
 * gravada em cada nó do GLB (`userData.explode`, ver
 * tools/make-panel-glb.mjs), com uma transição suave entre montado e
 * explodido.
 *
 * Sem nomes de peça hardcoded aqui — funciona com qualquer modelo. Um
 * modelo sem nenhuma peça marcada simplesmente não tem o que explodir
 * (`explodable` fica false), e quem chama decide esconder o botão nesse caso.
 */

const TRANSITION_SECONDS = 0.6;

export class ExplodeController {
  constructor(root) {
    this.parts = [];
    root?.traverse((obj) => {
      if (obj !== root && obj.userData?.explode) {
        this.parts.push({
          object: obj,
          rest: obj.position.clone(),
          offset: new THREE.Vector3(...obj.userData.explode),
        });
      }
    });
    this.factor = 0; // 0 = montado, 1 = totalmente explodido
    this.target = 0;
  }

  get explodable() {
    return this.parts.length > 0;
  }

  get exploded() {
    return this.target > 0.5;
  }

  /** Alterna montado <-> explodido; devolve o novo estado-alvo. */
  toggle() {
    this.target = this.target > 0.5 ? 0 : 1;
    return this.exploded;
  }

  /** Avança a transição; chamado a cada frame, mesmo sem nada para explodir. */
  update(delta) {
    if (!this.parts.length || this.factor === this.target) return;
    const step = delta / TRANSITION_SECONDS;
    this.factor =
      this.target > this.factor
        ? Math.min(this.target, this.factor + step)
        : Math.max(this.target, this.factor - step);
    const eased = easeInOutCubic(this.factor);
    for (const part of this.parts) {
      part.object.position.copy(part.rest).addScaledVector(part.offset, eased);
    }
  }

  /** Recoloca tudo montado, sem animação — usado ao reposicionar o equipamento. */
  reset() {
    this.factor = 0;
    this.target = 0;
    for (const part of this.parts) part.object.position.copy(part.rest);
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}
