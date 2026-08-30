import * as THREE from "three";

/**
 * Orientação de posicionamento — versão leve do "escaneamento guiado".
 *
 * NÃO faz reconstrução de malha nem fotogrametria (isso segue fora de escopo,
 * como o resto do projeto). O que faz:
 *
 *   1. Acompanha o deslocamento lateral da câmera enquanto o usuário procura
 *      onde colocar, e sugere continuar movendo devagar até o ARCore ter
 *      paralaxe suficiente mapeada — o mesmo conselho que o README já dava a
 *      quem testava manualmente, agora dito pelo próprio app.
 *   2. Quando o WebXR concede `plane-detection`, desenha o contorno real do
 *      plano detectado (não um retículo genérico) — o usuário vê exatamente
 *      até onde a superfície foi mapeada.
 *
 * NUNCA bloqueia a colocação: o toque funciona a qualquer momento, mesmo com
 * a varredura incompleta. É orientação, não obrigação.
 */

// Deslocamento lateral mínimo para considerar a varredura "suficiente".
const MIN_SWEEP_METERS = 0.15;

// Preallocação do contorno do plano: um polígono do ARCore raramente passa
// disso, e um buffer fixo evita alocar geometria nova a cada frame.
const MAX_PLANE_POINTS = 64;

// Se o plano mais próximo do retículo ainda está a mais que isso, não é o
// mesmo plano — melhor não desenhar nada a desenhar um contorno errado.
const MAX_PLANE_DISTANCE = 1.5;

export class PlacementGuide {
  constructor() {
    this.sweepDistance = 0;
    this.sweepReady = false;
    this.lastCameraPos = null;
    this.planeSupported = false;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_PLANE_POINTS * 3);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);

    // depthTest desligado pelo mesmo motivo do retículo: é uma guia de UI,
    // não deve sumir sob ruído do mapa de profundidade.
    this.outline = new THREE.LineLoop(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x00e0a4, transparent: true, opacity: 0.6, depthTest: false })
    );
    this.outline.renderOrder = 9;
    this.outline.visible = false;
    this.outline.frustumCulled = false;
    this.outline.matrixAutoUpdate = false;

    this._point = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
  }

  /** Chamado uma vez, depois que a sessão diz quais features foram concedidas. */
  setPlaneSupported(supported) {
    this.planeSupported = supported;
  }

  /** Zera a varredura — chamado ao reabrir o posicionamento (Reposicionar). */
  reset() {
    this.sweepDistance = 0;
    this.sweepReady = false;
    this.lastCameraPos = null;
    this.outline.visible = false;
  }

  /**
   * @param {XRFrame} frame
   * @param {XRReferenceSpace} referenceSpace
   * @param {{x:number,y:number,z:number}|null} cameraPos posição do viewer neste frame
   * @param {{x:number,y:number,z:number}|null} reticlePos posição do retículo (hit-test), para casar com o plano certo
   */
  update(frame, referenceSpace, cameraPos, reticlePos) {
    if (cameraPos) {
      if (this.lastCameraPos && !this.sweepReady) {
        const dx = cameraPos.x - this.lastCameraPos.x;
        const dz = cameraPos.z - this.lastCameraPos.z;
        this.sweepDistance += Math.hypot(dx, dz);
        if (this.sweepDistance >= MIN_SWEEP_METERS) this.sweepReady = true;
      }
      this.lastCameraPos = cameraPos;
    }

    this.outline.visible = false;
    if (!this.planeSupported || !reticlePos) return;
    const planes = frame.detectedPlanes;
    if (!planes || planes.size === 0) return;

    let bestPose = null;
    let bestPolygon = null;
    let bestDistance = MAX_PLANE_DISTANCE;
    for (const plane of planes) {
      if (plane.orientation && plane.orientation !== "horizontal") continue;
      const pose = frame.getPose(plane.planeSpace, referenceSpace);
      if (!pose) continue;
      const p = pose.transform.position;
      const dist = Math.hypot(p.x - reticlePos.x, p.z - reticlePos.z);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestPose = pose;
        bestPolygon = plane.polygon;
      }
    }

    if (!bestPose || !bestPolygon || bestPolygon.length < 3) return;

    this._matrix.fromArray(bestPose.transform.matrix);
    const attribute = this.outline.geometry.getAttribute("position");
    const count = Math.min(bestPolygon.length, MAX_PLANE_POINTS);
    for (let i = 0; i < count; i += 1) {
      const v = bestPolygon[i];
      this._point.set(v.x, v.y + 0.003, v.z).applyMatrix4(this._matrix);
      attribute.setXYZ(i, this._point.x, this._point.y, this._point.z);
    }
    attribute.needsUpdate = true;
    this.outline.geometry.setDrawRange(0, count);
    this.outline.visible = true;
  }

  /** Texto de orientação, ou null quando não há nada a dizer (varredura já suficiente). */
  hint(hasReticle) {
    if (!hasReticle) return "Aponte para uma superfície e mova o celular devagar";
    if (!this.sweepReady) return "Continue movendo o celular devagar para melhorar o mapeamento";
    return null;
  }

  dispose() {
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.outline.removeFromParent();
  }
}
