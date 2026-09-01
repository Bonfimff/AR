import * as THREE from "three";
import {
  loadEquipment,
  createSelectionOutline,
  fitSelectionOutline,
  disposeObject,
} from "./equipment.js";
import { PanelController } from "./panel.js";
import { ExplodeController } from "./explode.js";
import { getModel } from "./models.js";
import { CircuitModel } from "./circuits.js";

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
/**
 * Quem pode alimentar cada tipo. É a regra da instalação, não uma escolha de
 * interface: lâmpada responde a interruptor; interruptor e tomada penduram
 * direto num disjuntor. Tipos ausentes (fonte, disjuntor, caixa de passagem)
 * NÃO se associam — o disjuntor já é alimentado pela entrada do quadro, e
 * oferecê-lo para associação deixava um disjuntor "ligado" em outro.
 */
const FEEDER_KIND = {
  lamp: "switch",
  outlet: "breaker",
  switch: "breaker",
};

// Letra da etiqueta por tipo de elemento.
const TAGS = {
  equipamento: "Q",
  tomada: "T",
  interruptor: "I",
  luminaria: "L",
  eletroduto: "E",
};

export class ElementScene {
  /** @param {THREE.Object3D} anchorGroup grupo cuja pose vem da XRAnchor */
  constructor(anchorGroup) {
    this.anchorGroup = anchorGroup;
    this.elements = [];
    this.selected = null;
    this.nextId = 1;
    this.onAction = null;
    this.onSelectionChange = null;
    this.onCircuitChange = null;
    this.onLoadPick = null;
    this.tagCounts = {};

    /**
     * UM modelo elétrico para a instalação inteira, não um por elemento.
     * É o que permite ligar a luminária do teto ao interruptor da parede e ao
     * disjuntor do quadro: são objetos 3D distintos, mas um circuito só.
     *
     * Os ids locais de cada GLB ("carga", "chave", "d1") ganham prefixo da
     * instância — cinco tomadas trazem cinco "carga" e sem isso colidiriam.
     */
    this.circuit = new CircuitModel();
    this.circuit.onChange = () => {
      for (const element of this.elements) element.panel?.applyState();
      this.onCircuitChange?.(this);
    };
  }

  /**
   * Etiqueta curta e estável do elemento: I1, T2, L3...
   *
   * O contador NUNCA volta atrás, nem quando um elemento é removido. Contar os
   * existentes faria a próxima tomada depois de apagar a T1 chamar-se T2 de
   * novo — dois nomes iguais no mesmo menu de associação.
   */
  tagFor(modelId) {
    const letter = TAGS[modelId] ?? modelId[0].toUpperCase();
    this.tagCounts[modelId] = (this.tagCounts[modelId] ?? 0) + 1;
    return `${letter}${this.tagCounts[modelId]}`;
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

    // Id de instância: prefixo dos circuitos deste elemento, para que cinco
    // tomadas não colidam entre si no modelo elétrico global.
    const id = `${modelId}-${this.nextId++}`;
    const tag = this.tagFor(modelId);
    this.mergeCircuits(root.userData?.circuits, id, tag);

    const element = {
      id,
      tag,
      modelId,
      label: model.label,
      root,
      indicator: createSelectionOutline(root),
      // A ordem importa: PanelController reparenteia peças com dobradiça, e
      // ExplodeController guarda a posição de repouso de cada peça ao nascer.
      panel: new PanelController(root, { circuit: this.circuit, prefix: id }),
      explode: new ExplodeController(root),
    };
    element.panel.onAction = (message) => this.onAction?.(message, element);
    element.panel.onLoadPick = (globalId) => this.onLoadPick?.(globalId, element);

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
    // Tira também os circuitos do elemento: senão um interruptor continuaria
    // alimentando uma luminária que já não existe.
    for (const id of [...this.circuit.elements.keys()]) {
      if (id.startsWith(`${element.id}/`)) this.circuit.remove(id);
    }
    disposeObject(element.root);
    return true;
  }

  /**
   * Copia o esquema local do GLB para o modelo global, com os ids prefixados.
   * O rótulo ganha a etiqueta da instância ("D1" vira "Q1 D1", "Interruptor"
   * vira "I2 Interruptor") — sem isso o menu de associação mostraria três
   * "Interruptor" idênticos e indistinguíveis.
   */
  mergeCircuits(schema, prefix, tag) {
    if (!schema?.elements?.length) return;
    const gid = (local) => `${prefix}/${local}`;
    for (const local of schema.elements) {
      this.circuit.add({
        id: gid(local.id),
        kind: local.kind,
        label: `${tag} · ${local.label ?? local.id}`,
        closed: local.closed,
      });
    }
    for (const local of schema.elements) {
      for (const target of local.feeds ?? []) this.circuit.connect(gid(local.id), gid(target));
    }
    this.circuit.solve();
  }

  /**
   * Liga uma carga (ou um interruptor) a uma fonte (interruptor ou disjuntor).
   * SUBSTITUI a associação anterior: uma carga alimentada por dois circuitos
   * seria erro de instalação, não redundância.
   *
   * @param {string} loadId id global da carga
   * @param {string|null} sourceId id global da fonte, ou null para desligar
   */
  associate(loadId, sourceId) {
    if (!this.circuit.get(loadId)) return false;
    this.circuit.clearFeedsInto(loadId);
    if (sourceId && this.circuit.get(sourceId)) this.circuit.connect(sourceId, loadId);
    this.circuit.solve();
    // solve() só avisa quando a ENERGIZAÇÃO muda; a topologia mudou de todo
    // jeito, e a UI precisa saber para redesenhar o menu.
    this.onCircuitChange?.(this);
    return true;
  }

  /**
   * O que pode alimentar este elemento do circuito, e o que o alimenta hoje.
   * Uma lâmpada é comandada por interruptor; interruptor e tomada penduram
   * direto num disjuntor. É a regra da instalação, não uma escolha de UI.
   *
   * @returns {{kind, current, options: Array<{id,label}>}|null}
   */
  associationsFor(id) {
    const element = this.circuit.get(id);
    if (!element) return null;

    const wanted = FEEDER_KIND[element.kind] ?? null;
    if (!wanted) return null;

    const options = [];
    for (const candidate of this.circuit.elements.values()) {
      if (candidate.kind === wanted && candidate.id !== id) {
        options.push({ id: candidate.id, label: candidate.label });
      }
    }
    return {
      kind: wanted,
      current: this.circuit.feedersOf(id)[0] ?? null,
      options,
    };
  }

  /**
   * Ponto de conexão de um elemento, em espaço de MUNDO: onde um eletroduto
   * encosta nele. Vem de `connect` no registro do modelo; sem ele, o centro da
   * caixa envolvente — que numa luminária de teto cai no meio do difusor e num
   * quadro de 2 m cai na altura da cintura.
   */
  connectionPoint(element) {
    const offset = getModel(element.modelId).connect;
    element.root.updateMatrixWorld(true);
    if (offset) return element.root.localToWorld(new THREE.Vector3(...offset));
    return new THREE.Box3().setFromObject(element.root).getCenter(new THREE.Vector3());
  }

  /**
   * Traça um eletroduto do ponto de conexão de `from` até o de `to`.
   *
   * O modelo tem 1 m ao longo de X e é ESTICADO até o comprimento necessário.
   * O esticamento vai num grupo intermediário, não na raiz: a raiz carrega a
   * escala do usuário (barra de escala), e misturar as duas faria o eletroduto
   * mudar de comprimento ao escalar a peça.
   */
  async connect(from, to) {
    if (!from || !to || from === to) return null;
    const a = this.connectionPoint(from);
    const b = this.connectionPoint(to);
    const length = a.distanceTo(b);
    if (length < 0.02) return null; // pontos praticamente coincidentes

    const element = await this.add("eletroduto");
    element.link = { from: from.id, to: to.id };
    element.label = `Eletroduto ${from.tag}→${to.tag}`;

    const model = getModel("eletroduto");
    const inner = element.root.children[0];
    const stretch = new THREE.Group();
    stretch.name = "Stretch";
    element.root.remove(inner);
    stretch.add(inner);
    element.root.add(stretch);
    stretch.scale.x = length / (model.nominalLength ?? 1);

    // Posição no meio do vão, e orientação levando +X para a direção A->B.
    const middle = a.clone().add(b).multiplyScalar(0.5);
    element.root.position.copy(this.anchorGroup.worldToLocal(middle));
    element.root.quaternion.setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      b.clone().sub(a).normalize()
    );
    element.stretch = stretch;
    // O contorno de seleção foi ajustado ao tubo de 1 m; depois de esticado a
    // caixa é outra.
    fitSelectionOutline(element.indicator, element.root);
    return element;
  }

  /** Descarta tudo. Usado ao encerrar a sessão. */
  clear() {
    this.select(null);
    for (const element of this.elements) disposeObject(element.root);
    this.elements.length = 0;
    this.nextId = 1;
    this.tagCounts = {};
    this.circuit.elements.clear();
    this.circuit.solve();
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
