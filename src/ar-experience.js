import * as THREE from "three";
import { disposeObject } from "./equipment.js";
import { GestureController, LIMITS } from "./gestures.js";
import {
  DEPTH_SENSING_INIT,
  inspectDepthSensing,
  isOcclusionLive,
  CpuDepthOcclusion,
  ORIENTATIONS,
} from "./occlusion.js";
import { getModel } from "./models.js";
import { createHandProvider } from "./hand/index.js";
import { HandController, HAND_STATE } from "./hand-controller.js";
import { HandOcclusion } from "./hand-occlusion.js";
import { PlacementGuide } from "./placement-guide.js";
import { ElementScene, spawnPosition } from "./element-scene.js";
import { FpsMeter } from "./diagnostics.js";

/**
 * Sessão WebXR immersive-ar.
 *
 * Estrutura espacial:
 *   scene
 *     └─ anchorGroup   <- pose da XRAnchor, reescrita a cada frame pelo ARCore
 *          ├─ quadro    <- posição/rotação/escala definidas pelo usuário
 *          ├─ tomada
 *          └─ ...       <- demais elementos da instalação
 *
 * Manter o transform do usuário num filho da âncora é o que permite mover,
 * girar e escalar sem perder a referência espacial: a âncora continua sendo
 * corrigida pelo tracking, e os gestos só alteram o offset local.
 *
 * UMA âncora para a planta inteira — ver src/element-scene.js para o porquê.
 */
export class ARExperience {
  constructor({
    modelId,
    overlayRoot,
    gestureLayer,
    onStatus,
    onPlaced,
    onDepthStatus,
    onDiagnostics,
    onGestureMode,
    onHandDetected,
    onScale,
    onPanelAction,
    onSceneChange,
    onEnd,
  }) {
    this.modelId = modelId;
    this.model = getModel(modelId);
    this.overlayRoot = overlayRoot;
    this.gestureLayer = gestureLayer;
    this.onStatus = onStatus;
    this.onPlaced = onPlaced;
    this.onDepthStatus = onDepthStatus;
    this.onDiagnostics = onDiagnostics;
    this.onGestureMode = onGestureMode;
    this.onHandDetected = onHandDetected;
    this.onScale = onScale;
    this.onPanelAction = onPanelAction;
    this.onSceneChange = onSceneChange;
    this.onEnd = onEnd;
    this.scene3d = null; // ElementScene; nomeado assim para não colidir com this.scene
    this.lastReportedScale = 1;
    this.handEverDetected = false;
    this._inputKey = null; // chave de "alvo de entrada atual": ver applyInputTargets
    this.associating = null; // id do circuito com menu de associação aberto
    this.conduitMode = false;
    this.conduitFrom = null;

    this.session = null;
    this.anchor = null;
    this.placementRequested = false;
    this.awaitingPlacement = true;
    this.hasInteracted = false;
    this.lastFrameTime = 0;
    this.occlusionLive = false;

    this.handProvider = null;
    this.handController = null;
    this.cpuOcclusion = null;
    this.handMask = null;
    this.fps = new FpsMeter();
  }

  async start() {
    this.buildScene();

    this.session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "local"],
      // hand-tracking: só existe em headsets hoje, mas pedimos para não excluir
      // esse hardware. camera-access: é o que alimenta o MediaPipe sem disputar
      // a câmera com o ARCore.
      optionalFeatures: [
        "anchors",
        "dom-overlay",
        "depth-sensing",
        "hand-tracking",
        "camera-access",
        "plane-detection",
      ],
      domOverlay: { root: this.overlayRoot },
      depthSensing: DEPTH_SENSING_INIT,
    });

    this.overlayActive = this.session.domOverlayState?.type === "screen";
    this.anchorsSupported =
      typeof XRHitTestResult !== "undefined" && "createAnchor" in XRHitTestResult.prototype;

    this.session.addEventListener("end", () => this.cleanup());
    this.renderer.xr.setReferenceSpaceType("local");
    await this.renderer.xr.setSession(this.session);

    this.depthStatus = inspectDepthSensing(this.session);

    // O Three.js só cobre o modo gpu-optimized; no modo cpu fazemos o passe.
    if (this.depthStatus.enabled && this.depthStatus.usage === "cpu-optimized") {
      // ?depthorient=0..3 fixa a convenção quando ela já for conhecida.
      const forced = Number(new URLSearchParams(location.search).get("depthorient"));
      this.cpuOcclusion = new CpuDepthOcclusion({
        orientation: Number.isInteger(forced) ? forced : 1,
      });
      this.scene.add(this.cpuOcclusion.mesh);
    }
    this.depthStatus.cpu = Boolean(this.cpuOcclusion);
    console.info("[AR] depth-sensing:", this.depthStatus);

    this.placementGuide.setPlaneSupported(
      Boolean(this.session.enabledFeatures?.includes("plane-detection"))
    );

    this.referenceSpace = this.renderer.xr.getReferenceSpace();
    this.viewerSpace = await this.session.requestReferenceSpace("viewer");
    this.hitTestSource = await this.session.requestHitTestSource({ space: this.viewerSpace });

    try {
      // O equipamento âncora entra já aqui para a colocação ser instantânea.
      await this.scene3d.add(this.modelId);
      this.syncHandTargets();
    } catch (error) {
      this.onStatus(`Falha ao carregar ${this.model.url}.`);
      console.error(error);
    }

    this.setupInput();
    await this.setupHandTracking();

    // A OCLUSÃO POR PROFUNDIDADE NÃO ENTRA POR PADRÃO quando há máscara de mão.
    //
    // O depth-from-motion do S20 FE recortava o equipamento em manchas com
    // NADA na frente (visto em captura no aparelho). O filtro temporal + erosão
    // em occlusion.js reduz isso, mas não posso prometer que elimina — e um
    // recorte falso destrói a ilusão inteira, enquanto a máscara da mão é
    // geométrica e por construção nunca recorta onde não há mão.
    //
    // Sem máscara de mão a profundidade continua ligada: aí ela é a única
    // oclusão que existe, e uma ruim é melhor que nenhuma.
    // ?depth=1 força ligada para comparar; ?depth=0 força desligada.
    const depthParam = new URLSearchParams(location.search).get("depth");
    this.depthOcclusionOn =
      depthParam === "1" ? true : depthParam === "0" ? false : !this.handMask;
    this.cpuOcclusion?.setEnabled(this.depthOcclusionOn);

    // Reportado só agora para que o aviso já saiba se há máscara de mão.
    this.depthStatus.mask = Boolean(this.handMask);
    this.depthStatus.depthOn = this.depthOcclusionOn;
    this.onDepthStatus?.(this.depthStatus);
    this.onStatus("Aponte para uma superfície e mova o celular devagar");
    this.renderer.setAnimationLoop((time, frame) => this.render(time, frame));
  }

  /**
   * Botão "D": desligado -> visualiza orientação 0 -> 1 -> 2 -> 3 -> desligado.
   * A orientação escolhida continua valendo depois de fechar a visualização,
   * então dá para achar a certa olhando e seguir usando.
   */
  cycleDepthDebug() {
    if (!this.cpuOcclusion && !this.handMask) return false;

    if (!this.depthDebug) {
      this.depthDebug = true;
      this.cpuOcclusion?.setOrientation(0);
      this.cpuOcclusion?.setDebug(true);
      this.handMask?.setDebug(true); // silhueta em ciano, sobre o mapa
      return true;
    }

    // Com profundidade, cada toque avança uma orientação antes de desligar.
    if (this.cpuOcclusion) {
      const next = this.cpuOcclusion.orientation + 1;
      if (next < ORIENTATIONS) {
        this.cpuOcclusion.setOrientation(next);
        return true;
      }
    }

    this.depthDebug = false;
    this.cpuOcclusion?.setDebug(false);
    this.handMask?.setDebug(false);
    return false;
  }

  /** Hand tracking é opcional: se falhar, a experiência segue no touchscreen. */
  async setupHandTracking() {
    try {
      this.handProvider = await createHandProvider({
        session: this.session,
        renderer: this.renderer,
      });
    } catch (error) {
      console.error("[AR] hand tracking indisponível:", error);
      this.handProvider = null;
    }

    if (!this.handProvider || this.handProvider.kind === "off") return;

    // Máscara da mão: só faz sentido com um provider de mão ativo. Pode ser
    // desligada com ?handmask=0 para comparar com a oclusão por profundidade.
    if (new URLSearchParams(location.search).get("handmask") !== "0") {
      this.handMask = new HandOcclusion();
      this.scene.add(this.handMask.mesh);
    }

    this.handController = new HandController({
      getCamera: () => this.getXRCamera(),
      getRect: () => this.gestureLayer.getBoundingClientRect(),
      onStateChange: (state) => this.onHandStateChange(state),
      onModeChange: (mode) => this.onGestureMode?.(mode),
      onPointTap: (x, y) => this.handlePointTap(x, y),
    });
    this.syncHandTargets();
  }

  /**
   * Impede que mão e toque escrevam no mesmo transform ao mesmo tempo:
   * enquanto a mão segura o objeto, o controlador de toque fica sem alvo.
   */
  onHandStateChange(state) {
    if (!this.handEverDetected && state !== HAND_STATE.IDLE) {
      this.handEverDetected = true;
      this.onHandDetected?.();
    }
    if (state === HAND_STATE.OBJECT_SELECTED) {
      this.setSelected(true);
      this.gestures?.setTarget(null);
    } else if (state === HAND_STATE.RELEASED || state === HAND_STATE.IDLE) {
      if (this.selected) this.gestures?.setTarget(this.selectedElement.root);
    }
  }

  buildScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    document.body.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 3, 2);
    this.scene.add(key);

    // depthTest desligado: o retículo é uma guia de UI e não deve sumir sob o
    // ruído do mapa de profundidade nem brigar em z com o próprio piso.
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x00e0a4,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      })
    );
    this.reticle.renderOrder = 10;
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.placementGuide = new PlacementGuide();
    this.scene.add(this.placementGuide.outline);

    this.anchorGroup = new THREE.Group();
    this.anchorGroup.visible = false;
    this.scene.add(this.anchorGroup);

    this.scene3d = new ElementScene(this.anchorGroup);
    this.scene3d.onAction = (message) => this.onPanelAction?.(message);
    this.scene3d.onSelectionChange = () => this.reportScene();
    this.scene3d.onCircuitChange = () => this.reportScene();
    // Tocar numa carga (lâmpada, tomada) abre a associação: é a única ação
    // útil sobre ela — carga não se manobra.
    this.scene3d.onLoadPick = (circuitId) => this.openAssociation(circuitId);

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    this._onResize = () => this.onResize();
    window.addEventListener("resize", this._onResize);
    window.addEventListener("orientationchange", this._onResize);
  }

  onResize() {
    // Durante a sessão o próprio WebXR define projeção e viewport.
    if (!this.renderer || this.renderer.xr.isPresenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  setupInput() {
    if (this.overlayActive) {
      // Toques na UI do overlay não devem disparar o 'select' do WebXR.
      this._onBeforeSelect = (event) => event.preventDefault();
      this.overlayRoot.addEventListener("beforexrselect", this._onBeforeSelect);

      this.gestures = new GestureController({
        element: this.gestureLayer,
        getCamera: () => this.getXRCamera(),
        onTap: (x, y) => this.handleTap(x, y),
        onChange: () => this.markInteracted(),
        onModeChange: (mode) => this.onGestureMode?.(mode),
      });
    } else {
      // Sem dom-overlay não há eventos DOM: usa o 'select' do próprio WebXR.
      this._onSelect = () => this.requestPlacement();
      this.session.addEventListener("select", this._onSelect);
      console.warn("[AR] dom-overlay indisponível: gestos de manipulação desativados.");
    }
  }

  getXRCamera() {
    const xrCamera = this.renderer.xr.getCamera();
    return xrCamera.cameras[0] ?? xrCamera;
  }

  // ---- toque: colocar, selecionar, desselecionar ----

  handleTap(clientX, clientY) {
    if (this.awaitingPlacement) {
      this.requestPlacement();
      return;
    }
    const hit = this.raycastScene(clientX, clientY);
    if (this.handleConduitTap(hit?.element ?? null)) return;
    if (!hit) {
      this.setSelected(null);
      return;
    }

    // Com o elemento JÁ selecionado, um toque numa peça com função (disjuntor,
    // porta, tecla) opera a peça. Antes disso o toque só seleciona — do
    // contrário seria fácil desligar um circuito sem querer ao mirar no
    // elemento pela primeira vez.
    if (hit.element === this.selectedElement && hit.element.panel?.handlePick(hit.object)) return;
    this.setSelected(hit.element);
  }

  /**
   * 👉 apontar com o indicador: aciona a peça mirada.
   *
   * Diferente do toque na tela, NÃO exige selecionar antes. A regra de "só
   * opera se já estiver selecionado" existe porque no touchscreen o mesmo
   * toque que mira também seleciona, e sem ela o primeiro toque já desligaria
   * um circuito. Apontar é uma pose deliberada e distinta — não há esse risco,
   * e exigir uma pinça antes só tornaria o gesto trabalhoso.
   */
  /**
   * Modo "eletroduto A -> B": dois toques, um em cada elemento. Não é um
   * elemento que se "coloca": um eletroduto existe entre duas coisas, e pedir
   * ao usuário para posicioná-lo e girá-lo à mão seria trabalho manual para
   * algo que o app pode calcular exatamente.
   */
  startConduit() {
    this.conduitFrom = null;
    this.conduitMode = true;
    this.associating = null;
    this.onStatus("Eletroduto: toque no primeiro elemento");
    this.reportScene();
  }

  cancelConduit(message = "") {
    if (!this.conduitMode) return;
    this.conduitMode = false;
    this.conduitFrom = null;
    this.onStatus(message);
    this.reportScene();
  }

  /** @returns {boolean} true se o toque foi consumido pelo modo eletroduto */
  handleConduitTap(element) {
    if (!this.conduitMode) return false;
    if (!element) {
      this.cancelConduit("Eletroduto cancelado");
      this.onPanelAction?.("Eletroduto cancelado");
      return true;
    }
    if (!this.conduitFrom) {
      this.conduitFrom = element;
      this.setSelected(element);
      this.onStatus(`De ${element.tag} até... toque no segundo elemento`);
      return true;
    }
    if (element === this.conduitFrom) return true; // mesmo elemento: ignora

    const from = this.conduitFrom;
    this.conduitMode = false;
    this.conduitFrom = null;
    this.onStatus("");
    this.scene3d.connect(from, element).then((conduit) => {
      this.syncHandTargets();
      if (conduit) this.onPanelAction?.(`Eletroduto ${from.tag} → ${element.tag}`);
      this.reportScene();
    });
    return true;
  }

  handlePointTap(clientX, clientY) {
    if (this.awaitingPlacement) return;
    const hit = this.raycastScene(clientX, clientY);
    if (!hit) return;
    this.setSelected(hit.element);
    if (!hit.element.panel?.handlePick(hit.object)) this.onGestureMode?.("point");
  }

  /** @returns {{element, object}|null} peça atingida em QUALQUER elemento */
  raycastScene(clientX, clientY) {
    const camera = this.getXRCamera();
    if (!camera || !this.scene3d || this.scene3d.isEmpty) return null;
    const rect = this.gestureLayer.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this._ndc, camera);
    // O objeto atingido, não só "acertou algo": a interação por peça precisa
    // saber QUAL peça, e a seleção precisa saber de QUAL elemento.
    return this.scene3d.raycast(this.raycaster);
  }

  /** @param {object|null} element elemento da cena, ou null para desselecionar */
  setSelected(element) {
    if (this.scene3d?.selected === element) return;
    this.associating = null; // menu de associação é do elemento anterior
    this.scene3d?.select(element);
    this.applyInputTargets();
    if (!element) this.handController?.release();

    if (element) {
      this.markInteracted();
    } else if (this.hasInteracted) {
      this.onStatus("");
    }
  }

  /**
   * COM A PORTA ABERTA, mover/girar/altura/escala ficam desligados. Só
   * continuam valendo acionar disjuntor e fechar a porta.
   *
   * O motivo é reduzir erro de interpretação justamente quando ele custa mais:
   * com a porta aberta o usuário está mirando alvos pequenos dentro do
   * gabinete, e qualquer arrasto acidental tira o alvo de baixo do dedo. Menos
   * gestos possíveis, menos chance de confundir um com o outro.
   *
   * Toque e gesto de apontar NÃO passam por aqui — continuam funcionando, que
   * é exatamente o que se quer preservar.
   */
  applyInputTargets() {
    const element = this.selectedElement;
    const locked = Boolean(element?.panel?.doorOpen);

    // setTarget/setTargets zeram o estado de arrasto, então só chamamos quando
    // algo realmente mudou — a cada frame quebraria qualquer gesto em curso.
    const key = `${locked}|${element?.id ?? ""}`;
    if (key === this._inputKey) return;
    this._inputKey = key;

    this.gestures?.setTarget(locked ? null : (element?.root ?? null));
    this.handController?.setTargets(locked ? [] : (this.scene3d?.roots ?? []));

    if (locked) {
      this.handController?.release();
      this.onPanelAction?.("Porta aberta — mover e girar travados");
    }
  }

  /** Elemento selecionado agora, se houver. */
  get selectedElement() {
    return this.scene3d?.selected ?? null;
  }

  get selected() {
    return Boolean(this.scene3d?.selected);
  }

  /** O equipamento âncora — o primeiro colocado, referência da planta. */
  get equipment() {
    return this.scene3d?.anchorElement?.root ?? null;
  }

  /**
   * Acrescenta um elemento do catálogo à frente da câmera, já selecionado
   * para ser arrastado ao lugar. Só depois de a planta ter uma âncora: sem
   * ponto de referência não há onde pendurar o elemento.
   */
  async addElement(modelId) {
    if (this.awaitingPlacement || !this.scene3d) return null;
    const camera = this.getXRCamera();
    if (!camera) return null;

    const element = await this.scene3d.add(
      modelId,
      spawnPosition(camera, this.anchorGroup)
    );
    this.syncHandTargets();
    this.setSelected(element);
    this.onPanelAction?.(`${element.label} adicionada`);
    this.reportScene();
    return element;
  }

  /** Remove o elemento selecionado. A âncora da planta não pode ser removida. */
  removeSelected() {
    const element = this.selectedElement;
    if (!element || element === this.scene3d.anchorElement) return false;
    const label = element.label;
    this.scene3d.remove(element);
    this.syncHandTargets();
    this.onPanelAction?.(`${label} removida`);
    this.reportScene();
    return true;
  }

  /** A mão pode agarrar qualquer elemento, não só o equipamento âncora. */
  syncHandTargets() {
    this._inputKey = null; // a lista mudou: força reaplicar
    this.applyInputTargets();
  }

  /**
   * Abre (ou fecha) o menu de associação de um elemento do circuito.
   * @param {string|null} circuitId id GLOBAL, ou null para fechar
   */
  openAssociation(circuitId) {
    this.associating = circuitId && this.associating !== circuitId ? circuitId : null;
    this.reportScene();
  }

  /** Escolhe quem alimenta o circuito em associação. `null` desliga. */
  chooseAssociation(sourceId) {
    if (!this.associating) return;
    const load = this.scene3d.circuit.get(this.associating);
    this.scene3d.associate(this.associating, sourceId);
    const source = sourceId ? this.scene3d.circuit.get(sourceId) : null;
    this.onPanelAction?.(
      source ? `${load?.label} ligada a ${source.label}` : `${load?.label} desligada do circuito`
    );
    this.associating = null;
    this.reportScene();
  }

  /**
   * Circuitos associáveis do elemento selecionado. Um interruptor e uma tomada
   * têm um só; o quadro tem os três disjuntores, que são FONTES e não se
   * associam a nada — por isso a lista pode sair vazia.
   */
  associableOf(element) {
    if (!element || !this.scene3d) return [];
    const out = [];
    for (const id of element.panel?.byCircuit.keys() ?? []) {
      if (this.scene3d.associationsFor(id)) out.push(id);
    }
    return out;
  }

  /** Move o elemento selecionado em passos fixos, pelo controle de tela. */
  nudge(axis, step) {
    const element = this.selectedElement;
    if (!element) return;
    element.root.position[axis] += step;
    this.markInteracted();
    this.reportScene();
  }

  /** Estado da cena para a UI: o que existe e o que está selecionado. */
  reportScene() {
    const element = this.selectedElement;
    const associable = this.associableOf(element);
    const menu = this.associating ? this.scene3d.associationsFor(this.associating) : null;

    this.onSceneChange?.({
      count: this.scene3d?.elements.length ?? 0,
      conduit: this.conduitMode ? { from: this.conduitFrom?.tag ?? null } : null,
      selected: element
        ? {
            label: `${element.tag} · ${element.label}`,
            explodable: element.explode?.explodable ?? false,
            exploded: element.explode?.exploded ?? false,
            removable: element !== this.scene3d.anchorElement,
            position: element.root.position.clone(),
            // Um só circuito associável: o botão "Associar" já sabe qual abrir.
            associable: associable[0] ?? null,
          }
        : null,
      association: menu
        ? {
            id: this.associating,
            label: this.scene3d.circuit.get(this.associating)?.label ?? "",
            kind: menu.kind,
            current: menu.current,
            options: menu.options,
          }
        : null,
    });
  }

  markInteracted() {
    if (this.hasInteracted) return;
    this.hasInteracted = true;
    this.onStatus(""); // some o indicador após a primeira interação
  }

  requestPlacement() {
    if (this.awaitingPlacement && this.equipment) this.placementRequested = true;
  }

  reposition() {
    this.setSelected(false);
    this.awaitingPlacement = true;
    this.placementRequested = false;
    this.anchorGroup.visible = false;
    this.detachAnchor();
    this.cancelConduit();
    this.placementGuide.reset();
    // Reposicionar remonta tudo: evita arrastar peças soltas junto e devolve
    // os circuitos ao estado de fábrica.
    this.scene3d?.reset();
    this.onStatus("Aponte para uma superfície e mova o celular devagar");
  }

  /**
   * Escala definida pelo controle na tela. Escreve nos DOIS controladores além
   * do objeto: cada um mantém seu próprio `desired.scale` e, sem isto, o
   * primeiro frame de suavização puxaria o objeto de volta ao valor antigo.
   */
  setScale(scale) {
    const target = this.selectedElement?.root ?? this.equipment;
    if (!target) return;
    const clamped = THREE.MathUtils.clamp(scale, LIMITS.minScale, LIMITS.maxScale);
    target.scale.setScalar(clamped);
    this.gestures?.setScale(clamped);
    this.handController?.setScale(clamped);
    this.lastReportedScale = clamped;
    this.markInteracted();
  }

  /**
   * A pinça de dois dedos continua escalando (é um gesto de TELA, e o pedido
   * era tirar a escala da MÃO). Como as duas fontes escrevem na mesma escala,
   * o slider precisa acompanhar o gesto — senão exibe um valor mentiroso.
   */
  reportScale() {
    const target = this.selectedElement?.root ?? this.equipment;
    if (!target || !this.onScale) return;
    const scale = target.scale.x;
    if (Math.abs(scale - (this.lastReportedScale ?? -1)) < 0.001) return;
    this.lastReportedScale = scale;
    this.onScale(scale);
  }

  /** Alterna vista montada/explodida. Devolve {explodable, exploded}. */
  toggleExplode() {
    const element = this.selectedElement ?? this.scene3d?.anchorElement;
    if (!element?.explode?.explodable) return { explodable: false, exploded: false };
    // Explodir com a porta aberta jogaria a folha de lado: a direção da
    // explosão é local ao pivô da dobradiça, que está girado.
    element.panel?.closeDoor();
    const exploded = element.explode.toggle();
    this.reportScene();
    return { explodable: true, exploded };
  }

  detachAnchor() {
    this.anchor?.delete?.();
    this.anchor = null;
  }

  place(hitResult, pose) {
    this.awaitingPlacement = false;
    this.placementRequested = false;
    this.reticle.visible = false;

    // Rotação identidade: o espaço 'local' do ARCore é alinhado à gravidade,
    // então o equipamento fica de pé qualquer que seja a inclinação da superfície.
    this.anchorGroup.quaternion.identity();
    const p = pose.transform.position;
    this.anchorGroup.position.set(p.x, p.y, p.z);
    this.anchorGroup.visible = true;

    // Zera o transform do usuário a cada nova colocação.
    this.equipment.position.set(0, 0, 0);
    this.equipment.rotation.set(0, 0, 0);
    this.equipment.scale.setScalar(1);
    this.lastReportedScale = 1;
    this.onScale?.(1); // devolve o slider ao 100% junto com o objeto
    if (this.equipment.parent !== this.anchorGroup) this.anchorGroup.add(this.equipment);

    this.onStatus(this.hasInteracted ? "" : "Toque no objeto para manipular");
    this.onPlaced(this.scene3d.anchorElement?.explode?.explodable ?? false);
    // Já deixa o quadro selecionado: os botões do elemento (vista explodida,
    // posição) agem sobre a seleção, e sem isto eles sumiam logo após colocar.
    this.setSelected(this.scene3d.anchorElement);
    this.reportScene();

    if (this.anchorsSupported) {
      hitResult.createAnchor().then(
        (anchor) => {
          this.anchor = anchor;
        },
        () => {
          /* sem âncora: segue com a pose estática do hit-test */
        }
      );
    }
  }

  render(time, frame) {
    this.currentFrame = frame;
    const delta = this.lastFrameTime ? Math.min((time - this.lastFrameTime) / 1000, 0.1) : 0;
    this.lastFrameTime = time;

    if (frame) {
      const view = frame.getViewerPose(this.referenceSpace)?.views?.[0] ?? null;

      if (this.awaitingPlacement) {
        // O hit-test só é consultado enquanto há algo a posicionar.
        const results = this.hitTestSource ? frame.getHitTestResults(this.hitTestSource) : [];
        const pose = results[0]?.getPose(this.referenceSpace);
        this.reticle.visible = Boolean(pose);
        if (pose) {
          this.reticle.matrix.fromArray(pose.transform.matrix);
          if (this.placementRequested) this.place(results[0], pose);
        }

        // A colocação pode ter acontecido nesta mesma passada (placementRequested):
        // nesse caso o texto já foi definido por place(), e não deve ser sobrescrito.
        if (this.awaitingPlacement) {
          this.placementGuide.update(
            frame,
            this.referenceSpace,
            view?.transform?.position ?? null,
            pose?.transform?.position ?? null
          );
          const hint = this.placementGuide.hint(Boolean(pose));
          this.onStatus(hint ?? "Toque para posicionar");
        }
      } else {
        if (this.anchor) {
          // A âncora é reajustada pelo ARCore conforme o mapa do ambiente evolui.
          const anchorPose = frame.getPose(this.anchor.anchorSpace, this.referenceSpace);
          if (anchorPose) {
            const p = anchorPose.transform.position;
            this.anchorGroup.position.set(p.x, p.y, p.z);
          }
        }
        this.gestures?.update(delta);
        this.updateHand(view, time, delta);
        this.scene3d?.update(delta);
        this.applyInputTargets(); // a porta pode ter acabado de abrir/fechar
        this.reportScale();
      }

      this.cpuOcclusion?.update(frame, view, this.getXRCamera(), this.renderer);

      // A textura de profundidade só chega alguns frames depois do início.
      if (!this.occlusionLive && isOcclusionLive(this.renderer, this.cpuOcclusion)) {
        this.occlusionLive = true;
        this.onDepthStatus?.({ ...this.depthStatus, active: true, live: true });
      }
    }

    this.fps.tick(delta);
    this.reportDiagnostics(time);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * O controlador de mão só roda quando não há dedo na tela: o toque tem
   * prioridade, para que os dois nunca disputem o mesmo objeto.
   */
  updateHand(view, time, delta) {
    if (!this.handProvider) return;

    const camera = this.getXRCamera();
    const points = this.handProvider.update({
      frame: this.currentFrame,
      referenceSpace: this.referenceSpace,
      camera,
      xrCamera: view?.camera ?? null, // XRCamera do WebXR, não a do Three.js
      time: time / 1000,
    });

    // A máscara acompanha a mão mesmo durante um gesto de toque: ela é oclusão
    // visual, não entrada, e sumir no meio do arrasto seria pior.
    const viewport = camera?.viewport;
    const aspect = viewport ? viewport.z / viewport.w : window.innerWidth / window.innerHeight;
    this.handMask?.update(points, camera, aspect, time / 1000);

    // O controle, sim, cede a vez ao toque para não disputarem o objeto.
    if (!this.handController || this.gestures?.pointers.size > 0) return;
    this.handController.update(points, time / 1000, delta);
  }

  reportDiagnostics(time) {
    if (!this.onDiagnostics) return;
    const hand = this.handController?.sample;
    this.onDiagnostics(
      {
        ar: "SUPPORTED",
        hitTest: this.hitTestSource ? "ON" : "OFF",
        hand: (this.handProvider?.kind ?? "off").toUpperCase(),
        depth: this.occlusionLive
          ? `ACTIVE ${this.depthStatus?.gpu ? "GPU" : "CPU"}`
          : this.depthStatus?.enabled
            ? `ENABLED ${this.depthStatus.usage ?? ""}`
            : "UNSUPPORTED",
        orient: this.cpuOcclusion ? this.cpuOcclusion.orientation : "—",
        mask: this.handMask ? (this.handMask.active ? `ON ${this.handMask.distance.toFixed(2)}m` : "OFF") : "—",
        camera: this.handProvider?.hasCameraTexture
          ? "TEXTURE OK"
          : this.handProvider?.kind === "mediapipe"
            ? "NO TEXTURE"
            : "—",
        infer: this.handProvider?.inferences ?? 0,
        handDetected: hand ? "DETECTED" : "NOT DETECTED",
        pinch: hand?.pinching ? "ON" : "OFF",
        object: this.selected ? "SELECTED" : "FREE",
        state: this.handController?.state ?? "—",
        rollDelta:
          this.handController?.rollDeltaDeg != null
            ? `${this.handController.rollDeltaDeg.toFixed(1)}°`
            : "—",
        fps: this.fps.value,
      },
      time
    );
  }

  end() {
    this.session?.end();
  }

  cleanup() {
    this.renderer?.setAnimationLoop(null);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("orientationchange", this._onResize);

    if (this._onBeforeSelect) {
      this.overlayRoot.removeEventListener("beforexrselect", this._onBeforeSelect);
      this._onBeforeSelect = null;
    }
    if (this._onSelect) {
      this.session.removeEventListener("select", this._onSelect);
      this._onSelect = null;
    }

    this.gestures?.dispose();
    this.gestures = null;

    this.handController?.dispose();
    this.handController = null;
    this.cpuOcclusion?.dispose();
    this.cpuOcclusion = null;
    this.handMask?.dispose();
    this.handMask = null;
    this.placementGuide?.dispose();
    this.placementGuide = null;
    this.scene3d?.clear();
    this.handProvider?.dispose();
    this.handProvider = null;

    this.hitTestSource?.cancel?.();
    this.hitTestSource = null;
    this.detachAnchor();

    disposeObject(this.reticle);

    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.scene = null;
    this.session = null;

    this.awaitingPlacement = true;
    this.occlusionLive = false;
    this.onEnd();
  }
}
