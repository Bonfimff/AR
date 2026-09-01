import * as THREE from "three";
import { loadEquipment, createSelectionIndicator, disposeObject } from "./equipment.js";
import { PanelController } from "./panel.js";
import { ExplodeController } from "./explode.js";
import { getModel } from "./models.js";

/**
 * A instalação: vários elementos posicionados em volta de UMA âncora comum.
 *
 * UMA ÂNCORA PARA TUDO, e não uma por elemento. Duas razões, ambas decisivas:
 *
 *  - as posições RELATIVAS entre quadro, tomadas e luminárias ficam exatas.
 *    Com uma âncora por elemento, cada uma é corrigida pelo tracking de forma
 *    independente e a planta se deforma sozinha — inaceitável numa ferramenta
 *    cujo produto é justamente onde as coisas ficam em relação umas às outras;
 *  - salvar/carregar precisa de um único ponto de referência. Guardar a planta
 *    inteira em coordenadas relativas a uma origem e pedir só essa origem ao
 *    recarregar é exatamente o comportamento pretendido.
 *
 * O custo é que a planta inteira deriva junto se a âncora derivar. É o
 * trade-off certo: derivar junto preserva a geometria interna; derivar
 * separado a destrói.
 */
export class ElementScene {
  /** @param {THREE.Object3D} anchorGroup grupo cuja pose vem da XRAnchor */
  constructor(anchorGroup) {
    this.anchorGroup = anchorGroup;
    this.elements = [];
    this.selected = null;
    this.nextId = 1;
    this.onAction = null;
    this.onSelectionChange = null;
  }

  /** O primeiro elemento colocado: a referência da planta. */
  get anchorElement() {
    return this.elements[0] ?? null;
  }

  get isEmpty() {
    return this.elements.length === 0;
  }

  /** Raízes de todos os elementos — alvos possíveis de manipulação. */
  get roots() {
    return this.elements.map((element) => element.root);
  }

  /**
   * Carrega e acrescenta um elemento.
   * @param {string} modelId chave em src/models.js
   * @param {THREE.Vector3} [localPosition] posição no espaço da âncora
   */
  async add(modelId, localPosition) {
    const model = getModel(modelId);
    const root = await loadEquipment(model);

    const element = {
      // Id de instância: prefixo dos circuitos deste elemento, para que cinco
      // tomadas não colidam entre si no modelo elétrico global.
      id: `${modelId}-${this.nextId++}`,
      modelId,
      label: model.label,
      root,
      indicator: createSelectionIndicator(root),
      // A ordem importa: PanelController reparenteia peças com dobradiça, e
      // ExplodeController guarda a posição de repouso de cada peça ao nascer.
      panel: new PanelController(root),
      explode: new ExplodeController(root),
    };
    element.panel.onAction = (message) => this.onAction?.(message, element);

    if (localPosition) root.position.copy(localPosition);
    this.anchorGroup.add(root);
    this.elements.push(element);
    return element;
  }

  remove(element) {
    const index = this.elements.indexOf(element);
    if (index < 0) return false;
    if (this.selected === element) this.select(null);
    this.elements.splice(index, 1);
    disposeObject(element.root);
    return true;
  }

  /** Descarta tudo. Usado ao encerrar a sessão. */
  clear() {
    this.select(null);
    for (const element of this.elements) disposeObject(element.root);
    this.elements.length = 0;
    this.nextId = 1;
  }

  select(element) {
    if (this.selected === element) return this.selected;
    if (this.selected?.indicator) this.selected.indicator.visible = false;
    this.selected = element ?? null;
    if (this.selected?.indicator) this.selected.indicator.visible = true;
    this.onSelectionChange?.(this.selected);
    return this.selected;
  }

  /**
   * Qual elemento contém este objeto? O raycast acerta uma malha lá no fundo
   * da hierarquia, então subimos até achar a raiz registrada.
   */
  ownerOf(object) {
    for (let node = object; node; node = node.parent) {
      const element = this.elements.find((candidate) => candidate.root === node);
      if (element) return element;
    }
    return null;
  }

  /**
   * Primeira peça atingida em QUALQUER elemento, com o elemento dono junto.
   * @returns {{element, object, distance}|null}
   */
  raycast(raycaster) {
    const hit = raycaster.intersectObjects(this.roots, true)[0];
    if (!hit) return null;
    const element = this.ownerOf(hit.object);
    return element ? { element, object: hit.object, distance: hit.distance } : null;
  }

  /** Avança animações de porta e de vista explodida de todos os elementos. */
  update(delta) {
    for (const element of this.elements) {
      element.panel?.update(delta);
      element.explode?.update(delta);
    }
  }

  /** Volta tudo ao estado de fábrica, sem remover nada. */
  reset() {
    for (const element of this.elements) {
      element.panel?.reset();
      element.explode?.reset();
    }
  }
}

/**
 * Ponto, no espaço da âncora, onde colocar um elemento novo: à frente da
 * câmera, na altura do piso da planta.
 *
 * Colocar na origem empilharia todo elemento novo dentro do quadro; colocar no
 * retículo exigiria mirar o chão antes de cada adição. À frente de quem olha é
 * o que menos atrapalha — e o elemento nasce selecionado, pronto para ser
 * arrastado ao lugar certo.
 */
export function spawnPosition(camera, anchorGroup, distance = 0.9) {
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
    .setY(0);
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1); // câmera olhando a pino
  forward.normalize().multiplyScalar(distance);

  const world = camera.getWorldPosition(new THREE.Vector3()).add(forward);
  return anchorGroup.worldToLocal(world).setY(0);
}
