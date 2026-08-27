import * as THREE from "three";

/**
 * Converte um ponto da tela (pixels CSS) num ponto 3D sobre um plano horizontal
 * do mundo. É o elo entre qualquer entrada 2D (dedo no touchscreen ou mão vista
 * pela câmera) e o espaço da realidade aumentada — nunca movemos o objeto por
 * coordenadas de tela diretamente.
 */
const _ndc = new THREE.Vector2();

export class ScreenRay {
  constructor() {
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane();
    this.point = new THREE.Vector3();
  }

  /** Define o plano horizontal que passa por um ponto do mundo. */
  setHorizontalPlaneAt(worldPoint) {
    this.plane.setFromNormalAndCoplanarPoint(THREE.Object3D.DEFAULT_UP, worldPoint);
  }

  /** @returns {THREE.Vector3|null} ponto no plano, em espaço de mundo */
  intersect(clientX, clientY, camera, rect) {
    if (!camera) return null;
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(_ndc, camera);
    return this.raycaster.ray.intersectPlane(this.plane, this.point) ? this.point : null;
  }

  /**
   * Raycast contra um objeto. Devolve o PONTO atingido, não apenas true/false:
   * é a altura desse ponto que define o plano de arrasto. Usar a base do objeto
   * quebra com equipamentos altos — o ponto agarrado fica acima da linha do
   * horizonte e o raio nunca cruza um plano na altura do chão.
   *
   * @returns {THREE.Vector3|null}
   */
  firstHit(clientX, clientY, camera, rect, object) {
    if (!camera || !object) return null;
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(_ndc, camera);
    const hits = this.raycaster.intersectObject(object, true);
    return hits.length ? hits[0].point.clone() : null;
  }
}
