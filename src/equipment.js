import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Carrega o GLB do equipamento e o normaliza para uso em AR:
 * base apoiada em y = 0 e centrado em X/Z, sem alterar a escala do modelo
 * (o GLB deve estar modelado em metros, como manda a convenção glTF).
 */
export async function loadEquipment(entry) {
  const { url, dimensions, fitToDimensions, version } =
    typeof entry === "string" ? { url: entry } : entry;

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(version ? `${url}?v=${version}` : url);

  const model = gltf.scene;
  let box = new THREE.Box3().setFromObject(model);
  let size = box.getSize(new THREE.Vector3());

  // Escala física: ajusta o GLB às dimensões reais declaradas no registro,
  // preservando a proporção pelo eixo mais restritivo.
  if (dimensions && fitToDimensions) {
    const factor = Math.min(
      dimensions.width / (size.x || 1),
      dimensions.height / (size.y || 1),
      dimensions.depth / (size.z || 1)
    );
    if (Number.isFinite(factor) && factor > 0) {
      model.scale.multiplyScalar(factor);
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
      size = box.getSize(new THREE.Vector3());
    }
  }

  const center = box.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -box.min.y, -center.z);

  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 10 || maxDim < 0.02) {
    console.warn(
      `[AR] Equipamento com ${maxDim.toFixed(2)} m na maior dimensão. ` +
        "Verifique o GLB ou as dimensões declaradas em src/models.js."
    );
  }

  // Grupo externo: recebe as transformações do usuário (posição/rotação/escala).
  const object = new THREE.Group();
  object.name = "Equipamento";
  object.add(model);
  object.userData.size = size;
  object.userData.footprint = Math.max(Math.hypot(size.x, size.z) / 2, 0.12);

  return object;
}

/**
 * Anel discreto no piso, sob o objeto, indicando o estado "selecionado".
 * Entra como filho do objeto para acompanhar posição, rotação e escala.
 */
export function createSelectionIndicator(object) {
  const radius = object.userData.footprint * 1.2;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.94, radius, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x00e0a4,
      transparent: true,
      opacity: 0.85,
      // Mesmo tratamento do retículo: é uma guia de UI, não algo físico, então
      // não deve ficar recortado pelo mapa de profundidade. Sem isto, ruído do
      // depth-from-motion perto do chão (ver despeckle() em occlusion.js)
      // quebrava o anel em arcos soltos em vez de um círculo contínuo.
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  ring.name = "SelectionIndicator";
  ring.position.y = 0.005; // evita z-fighting com o piso
  ring.renderOrder = 5; // depois das passadas de oclusão (renderOrder negativo)
  ring.visible = false;
  ring.raycast = () => {}; // não deve capturar o toque de seleção
  object.add(ring);
  return ring;
}

/** Libera geometrias, materiais e texturas de uma subárvore. */
export function disposeObject(object) {
  if (!object) return;
  object.traverse((child) => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : child.material
        ? [child.material]
        : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && value.isTexture) value.dispose();
      }
      material.dispose();
    }
  });
  object.removeFromParent();
}
