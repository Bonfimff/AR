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
// Curso da alavanca ao desligar. Limitado a 4 cm porque a alavanca passa na
// frente do marcador: mais que isso e ela cobre justamente o indicador que
// deveria ficar visivel.
const LEVER_DROP = 0.04;

// Marcador de estado do disjuntor. Verde = entregando energia; laranja = não.
// Laranja e não vermelho de propósito: um disjuntor aberto é uma condição
// normal de operação, não uma falha, e vermelho já é a cor de um sinalizador
// de alarme na porta.
const MARKER_ON = new THREE.Color(0x22c55e);
const MARKER_OFF = new THREE.Color(0xf97316);

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
      // Alavanca e marcador são filhos do disjuntor: o circuito é o do pai.
      if (data.role === "lever" || data.role === "marker") {
        const owner = obj.parent?.userData?.circuitId;
        if (owner) {
          const entry = this.entry(owner);
          if (data.role === "lever") {
            entry.lever = obj;
            entry.leverRest = obj.position.y;
          } else {
            entry.marker = obj;
          }
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
      entry = { object: null, lever: null, leverRest: 0, marker: null, material: null };
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

  /** Dá instância própria de material a tudo que muda de cor sozinho. */
  prepareMaterials() {
    for (const [id, entry] of this.byCircuit) {
      const element = this.circuit.get(id);
      if (!element) continue;

      if (entry.marker) {
        entry.markerMaterial = cloneMaterial(entry.marker);
        // Com marcador, é ELE que indica o estado; o corpo da peça fica como
        // está. Escurecer a placa de uma tomada além de apagar o marcador
        // seria redundante e feio.
        continue;
      }

      // Sem marcador, a própria peça acende — é o caso do difusor da luminária
      // e das lâmpadas de sinalização do quadro. Manobráveis não acendem.
      if (KIND[element.kind].switchable || !entry.object) continue;
      const material = cloneMaterial(entry.object);
      if (!material) continue;
      entry.material = material;
      entry.baseColor = material.color.clone();
      entry.baseEmissive = material.emissive?.clone() ?? new THREE.Color(0, 0, 0);
    }
  }

  /** Escreve o estado elétrico corrente na cena. */
  applyState() {
    for (const [id, entry] of this.byCircuit) {
      const element = this.circuit.get(id);
      if (!element) continue;

      // `isLive` e NÃO `closed`/`isEnergized`: um disjuntor fechado a jusante
      // de um geral desligado não está entregando energia, e uma tomada sem
      // alimentação não está viva. Mostrar qualquer um deles como verde seria
      // a mentira mais perigosa que este painel pode contar.
      const live = this.circuit.isLive(id);

      // Alavanca para baixo = desligado. Feedback do próprio objeto, não um
      // rótulo na tela. Só existe em peça manobrável.
      if (entry.lever && KIND[element.kind].switchable) {
        entry.lever.position.y = entry.leverRest - (element.closed ? 0 : LEVER_DROP);
      }

      // Marcador: vale para QUALQUER tipo, não só manobrável. Uma tomada não
      // tem parte móvel que denuncie o estado — é só o marcador que a
      // distingue de uma tomada energizada.
      if (entry.markerMaterial) {
        entry.markerMaterial.color.copy(live ? MARKER_ON : MARKER_OFF);
        entry.markerMaterial.emissive?.copy(live ? MARKER_ON : MARKER_OFF).multiplyScalar(0.45);
        continue;
      }

      // Sem marcador, a carga acende sozinha (difusor, lâmpada de sinalização).
      if (!entry.material) continue;
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

/**
 * Materiais do glTF são COMPARTILHADOS entre peças que usam o mesmo. Quem vai
 * ser recolorido individualmente precisa da própria cópia — sem isto, apagar
 * uma lâmpada apagaria todas as do mesmo tipo.
 */
function cloneMaterial(root) {
  let cloned = null;
  root.traverse((child) => {
    if (!child.isMesh || Array.isArray(child.material) || cloned) return;
    child.material = child.material.clone();
    cloned = child.material;
  });
  return cloned;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}
