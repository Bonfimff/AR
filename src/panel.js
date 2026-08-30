import * as THREE from "three";
import { CircuitModel, KIND } from "./circuits.js";

/**
 * Liga o modelo elétrico (dado puro, src/circuits.js) à cena 3D.
 *
 * Esta é a ÚNICA classe que conhece as duas coisas. O modelo elétrico não sabe
 * que existe render; a cena não decide nada sobre energia. Aqui só há tradução:
 *
 *   toque numa peça  -> manobra no modelo      (handlePick)
 *   estado do modelo -> cor/posição na cena    (applyState)
 *
 * Nada é hardcoded por nome de peça: tudo vem de `userData` gravado no GLB
 * (ver tools/make-panel-glb.mjs), mesmo mecanismo já usado pela vista
 * explodida. Um modelo sem esses metadados simplesmente não tem interação, e
 * `interactive` fica false.
 */

const DOOR_SECONDS = 0.5;
const LEVER_DROP = 0.022; // quanto a alavanca desce ao desligar (m)

export class PanelController {
  constructor(root) {
    this.root = root;
    this.circuit = null;
    this.byCircuit = new Map(); // circuitId -> {meshes: [], lever: Object3D|null}
    this.door = null;
    this.doorFactor = 0;
    this.doorTarget = 0;
    this.onAction = null;

    const schema = root?.userData?.circuits;
    if (!schema) return;
    this.circuit = CircuitModel.fromJSON(schema);

    root.traverse((obj) => {
      const data = obj.userData ?? {};
      if (data.circuitId) this.entry(data.circuitId).object = obj;
      if (data.role === "lever") {
        // A alavanca é filha do disjuntor: o circuito é o do pai.
        const owner = obj.parent?.userData?.circuitId;
        if (owner) {
          const entry = this.entry(owner);
          entry.lever = obj;
          entry.leverRest = obj.position.y;
        }
      }
      if (data.hinge && !this.door) this.door = { object: obj, hinge: data.hinge };
    });

    this.setupHinge();
    this.prepareMaterials();
    this.circuit.onChange = () => this.applyState();
    this.applyState();
  }

  entry(circuitId) {
    let entry = this.byCircuit.get(circuitId);
    if (!entry) {
      entry = { object: null, lever: null, leverRest: 0, material: null };
      this.byCircuit.set(circuitId, entry);
    }
    return entry;
  }

  /** Há algo com que interagir neste modelo? */
  get interactive() {
    return Boolean(this.circuit) && (this.byCircuit.size > 0 || Boolean(this.door));
  }

  /**
   * A porta gira em torno da dobradiça, não do próprio centro. Como a
   * geometria do GLB está em coordenadas absolutas do modelo, envolvemos a
   * peça num grupo posicionado na dobradiça e compensamos o deslocamento —
   * assim girar o grupo gira a folha em torno da aresta certa.
   *
   * Precisa acontecer ANTES de ExplodeController ser construído: ele guarda a
   * posição de repouso de cada peça, e esta reparentagem muda a da porta.
   */
  setupHinge() {
    if (!this.door) return;
    const { object, hinge } = this.door;
    const parent = object.parent;
    if (!parent) return;

    const pivot = new THREE.Group();
    pivot.name = `${object.name}Pivot`;
    pivot.position.set(...hinge.pivot);
    parent.add(pivot);
    pivot.add(object);
    object.position.sub(pivot.position);

    this.door.pivot = pivot;
    this.door.openRad = THREE.MathUtils.degToRad(hinge.openDeg ?? 90);
  }

  /**
   * Materiais do glTF são COMPARTILHADOS entre peças que usam o mesmo — duas
   * lâmpadas do mesmo tipo apontam para a mesma instância. Apagar uma
   * apagaria a outra, então cada carga ganha sua cópia.
   */
  prepareMaterials() {
    for (const [id, entry] of this.byCircuit) {
      const element = this.circuit.get(id);
      if (!element || KIND[element.kind].switchable || !entry.object) continue;
      entry.object.traverse((child) => {
        if (!child.isMesh || Array.isArray(child.material)) return;
        child.material = child.material.clone();
        entry.material = child.material;
        entry.baseColor = child.material.color.clone();
        entry.baseEmissive = child.material.emissive?.clone() ?? new THREE.Color(0, 0, 0);
      });
    }
  }

  /** Escreve o estado elétrico corrente na cena. */
  applyState() {
    for (const [id, entry] of this.byCircuit) {
      const element = this.circuit.get(id);
      if (!element) continue;

      if (KIND[element.kind].switchable) {
        // Alavanca para baixo = desligado. É o feedback do próprio objeto,
        // não um rótulo na tela.
        if (entry.lever) {
          entry.lever.position.y = entry.leverRest - (element.closed ? 0 : LEVER_DROP);
        }
        continue;
      }

      // Carga: acende só se estiver de fato alimentada. `isLive` e não
      // `isEnergized` — ver a distinção em circuits.js.
      if (!entry.material) continue;
      const live = this.circuit.isLive(id);
      entry.material.emissive?.copy(live ? entry.baseEmissive : BLACK);
      entry.material.color.copy(entry.baseColor).multiplyScalar(live ? 1 : 0.35);
    }
  }

  /**
   * Um toque acertou este objeto — há algo a fazer com ele?
   * Devolve true quando a interação foi consumida (e a seleção do equipamento
   * não deve mudar), false quando o toque era em peça sem função.
   *
   * Sobe pela hierarquia porque o raycast acerta a malha, que pode ser filha
   * do nó que carrega o metadado.
   */
  handlePick(object) {
    for (let node = object; node; node = node.parent) {
      const data = node.userData ?? {};

      if (data.hinge && this.door?.object === node) {
        const open = this.toggleDoor();
        this.onAction?.(open ? "Porta aberta" : "Porta fechada");
        return true;
      }

      const id = data.circuitId ?? node.parent?.userData?.circuitId;
      if (!id) continue;
      const element = this.circuit?.get(id);
      if (!element) continue;

      if (!KIND[element.kind].switchable) {
        // Carga: não se manobra, mas informar o estado é útil.
        this.onAction?.(
          `${element.label}: ${this.circuit.isLive(id) ? "energizada" : "sem energia"}`
        );
        return true;
      }

      const closed = this.circuit.toggle(id);
      this.onAction?.(`${element.label} ${closed ? "ligado" : "desligado"}`);
      return true;
    }
    return false;
  }

  get doorOpen() {
    return this.doorTarget > 0.5;
  }

  toggleDoor() {
    if (!this.door?.pivot) return false;
    this.doorTarget = this.doorOpen ? 0 : 1;
    return this.doorOpen;
  }

  /**
   * Fecha a porta sem animação. A vista explodida chama isto porque as duas
   * coisas se atrapalham: a direção da explosão da porta é local ao pivô, e
   * com a folha aberta ela sairia de lado em vez de para a frente.
   */
  closeDoor() {
    this.doorTarget = 0;
    this.doorFactor = 0;
    if (this.door?.pivot) this.door.pivot.rotation.y = 0;
  }

  update(delta) {
    if (!this.door?.pivot || this.doorFactor === this.doorTarget) return;
    const step = delta / DOOR_SECONDS;
    this.doorFactor =
      this.doorTarget > this.doorFactor
        ? Math.min(this.doorTarget, this.doorFactor + step)
        : Math.max(this.doorTarget, this.doorFactor - step);
    this.door.pivot.rotation.y = this.door.openRad * easeInOutCubic(this.doorFactor);
  }

  /** Volta ao estado de fábrica: tudo ligado, porta fechada. */
  reset() {
    this.closeDoor();
    if (!this.circuit) return;
    for (const element of this.circuit.elements.values()) {
      if (KIND[element.kind].switchable) element.closed = true;
    }
    this.circuit.solve();
    this.applyState();
  }
}

const BLACK = new THREE.Color(0, 0, 0);

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}
