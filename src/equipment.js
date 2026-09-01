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
  // O esquema elétrico vem em `scene.extras` do glTF e o GLTFLoader o entrega
  // em `gltf.scene.userData`. Sobe para o grupo externo porque é ele que o
  // resto do app manipula — quem consome (src/panel.js) não deveria precisar
  // saber que existe um wrapper.
  if (model.userData?.circuits) object.userData.circuits = model.userData.circuits;
  object.userData.size = size;
  object.userData.footprint = Math.max(Math.hypot(size.x, size.z) / 2, 0.12);

  return object;
}

/**
 * Caixa de contorno indicando o estado "selecionado".
 *
 * Era um anel no piso, que só faz sentido para algo APOIADO no piso. Com a
 * instalação ganhando luminária de teto, tomada na parede e eletroduto
 * inclinado, o anel virava um disco deitado atravessando a peça — e num
 * eletroduto de 2 m ele tinha 1,2 m de diâmetro. Uma caixa acompanha qualquer
 * peça em qualquer orientação.
 */
export function createSelectionOutline(object) {
  // Cubo unitário em arestas: 12 segmentos, escalados para a caixa da peça.
  const positions = [];
  const corner = (i) => [i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5];
  for (let i = 0; i < 8; i += 1) {
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue; // desenha cada aresta uma vez só
      positions.push(...corner(i), ...corner(i | bit));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

  const outline = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x00e0a4,
      transparent: true,
      opacity: 0.9,
      // Mesmo tratamento do retículo: é guia de UI, não algo físico, e não
      // deve ficar recortada pelo mapa de profundidade.
      depthTest: false,
      depthWrite: false,
    })
  );
  outline.name = "SelectionOutline";
  outline.renderOrder = 5;
  outline.visible = false;
  outline.raycast = () => {}; // não captura o toque de seleção
  object.add(outline);
  fitSelectionOutline(outline, object);
  return outline;
}

/**
 * Ajusta o contorno à caixa da peça, em espaço LOCAL dela.
 *
 * A caixa é montada a partir da geometria de cada malha, e não com
 * `Box3.setFromObject` seguido da inversa da matriz: aquele caminho devolve
 * uma caixa alinhada ao MUNDO, e desalinhá-la de volta infla o resultado em
 * qualquer peça girada — justamente o caso do eletroduto.
 */
export function fitSelectionOutline(outline, object) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  const local = new THREE.Matrix4();

  object.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(object.matrixWorld).invert();

  object.traverse((child) => {
    if (!child.isMesh || !child.geometry || child === outline) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    const bounds = child.geometry.boundingBox;
    local.multiplyMatrices(toLocal, child.matrixWorld);
    for (let i = 0; i < 8; i += 1) {
      point
        .set(
          i & 1 ? bounds.max.x : bounds.min.x,
          i & 2 ? bounds.max.y : bounds.min.y,
          i & 4 ? bounds.max.z : bounds.min.z
        )
        .applyMatrix4(local);
      box.expandByPoint(point);
    }
  });

  if (box.isEmpty()) return outline;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Uma folga pequena e um piso de tamanho: numa tomada de 9 cm a caixa
  // encostada na peça fica indistinguível da própria peça.
  outline.scale.set(
    Math.max(size.x, 0.05) * 1.08,
    Math.max(size.y, 0.05) * 1.08,
    Math.max(size.z, 0.05) * 1.08
  );
  outline.position.copy(center);
  return outline;
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
