import * as THREE from "three";
import { loadEquipment, createSelectionIndicator, disposeObject } from "./equipment.js";
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
import { ExplodeController } from "./explode.js";
import { PanelController } from "./panel.js";
import { FpsMeter } from "./diagnostics.js";

/**
 * Sessão WebXR immersive-ar.
 *
 * Estrutura espacial (inalterada da V1):
 *   scene
 *     └─ anchorGroup   <- pose da XRAnchor, reescrita a cada frame pelo ARCore
 *          └─ equipment <- posição/rotação/escala definidas pelo usuário
 *
 * Manter o transform do usuário num filho da âncora é o que permite mover,
 * girar e escalar sem perder a referência espacial: a âncora continua sendo
 * corrigida pelo tracking, e os gestos só alteram o offset local.
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
    onEnd,
  }) {
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
    this.onEnd = onEnd;
    this.panel = null;
    this.lastReportedScale = 1;
    this.handEverDetected = false;

    this.session = null;
    this.equipment = null;
    this.selectionIndicator = null;
    this.anchor = null;
    this.placementRequested = false;
    this.awaitingPlacement = true;
    this.selected = false;
    this.hasInteracted = false;
    this.lastFrameTime = 0;
    this.occlusionLive = false;

    this.handProvider = null;
    this.handController = null;
    this.cpuOcclusion = null;
    this.handMask = null;
    this.explode = null;
    this.fps = new FpsMeter();
  }

  async start() {
    this.buildScene();

    // Pré-carrega o modelo para que a colocação seja instantânea.
    const modelPromise = loadEquipment(this.model);

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
      this.equipment = await modelPromise;
      this.selectionIndicator = createSelectionIndicator(this.equipment);
      // Ordem importa: o PanelController reparenteia a porta sob um pivô de
      // dobradiça, e o ExplodeController guarda a posição de repouso de cada
      // peça na construção. Invertido, a porta explodiria a partir do lugar
      // errado.
      this.panel = new PanelController(this.equipment);
      this.panel.onAction = (message) => this.onPanelAction?.(message);
      this.explode = new ExplodeController(this.equipment);
      this.handController?.setTarget(this.equipment);
    } catch (error) {
      this.onStatus(`Falha ao carregar ${this.model.url}.`);
      console.error(error);
    }

    this.setupInput();
    await this.setupHandTracking();

    // Reportado só agora para que o aviso já saiba se há máscara de mão.
    this.depthStatus.mask = Boolean(this.handMask);
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
    this.handController.setTarget(this.equipment ?? null);
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
      if (this.selected) this.gestures?.setTarget(this.equipment);
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
    if (!this.equipment) return;

    const hitObject = this.raycastEquipment(clientX, clientY);
    if (!hitObject) {
      if (this.selected) this.setSelected(false);
      return;
    }

    // Com o equipamento JÁ selecionado, um toque numa peça com função
    // (disjuntor, porta) opera a peça. Antes disso o toque só seleciona — do
    // contrário seria fácil desligar um circuito sem querer ao mirar no
    // equipamento pela primeira vez.
    if (this.selected && this.panel?.handlePick(hitObject)) return;
    this.setSelected(true);
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
  handlePointTap(clientX, clientY) {
    if (this.awaitingPlacement || !this.equipment) return;
    const hitObject = this.raycastEquipment(clientX, clientY);
    if (!hitObject) return;
    this.setSelected(true);
    if (!this.panel?.handlePick(hitObject)) this.onGestureMode?.("point");
  }

  raycastEquipment(clientX, clientY) {
    const camera = this.getXRCamera();
    if (!camera) return null;
    const rect = this.gestureLayer.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this._ndc, camera);
    // O objeto acertado, não só "acertou algo": a interação por peça precisa
    // saber QUAL peça.
    return this.raycaster.intersectObject(this.equipment, true)[0]?.object ?? null;
  }

  setSelected(selected) {
    if (this.selected === selected) return;
    this.selected = selected;
    if (this.selectionIndicator) this.selectionIndicator.visible = selected;
    this.gestures?.setTarget(selected ? this.equipment : null);
    if (!selected) this.handController?.release();

    if (selected) {
      this.markInteracted();
    } else if (this.hasInteracted) {
      this.onStatus("");
    }
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
    this.placementGuide.reset();
    this.explode?.reset(); // reposicionar remonta: evita mover peças soltas junto
    this.panel?.reset(); // e volta o quadro ao estado de fábrica
    this.onStatus("Aponte para uma superfície e mova o celular devagar");
  }

  /**
   * Escala definida pelo controle na tela. Escreve nos DOIS controladores além
   * do objeto: cada um mantém seu próprio `desired.scale` e, sem isto, o
   * primeiro frame de suavização puxaria o objeto de volta ao valor antigo.
   */
  setScale(scale) {
    if (!this.equipment) return;
    const clamped = THREE.MathUtils.clamp(scale, LIMITS.minScale, LIMITS.maxScale);
    this.equipment.scale.setScalar(clamped);
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
    if (!this.equipment || !this.onScale) return;
    const scale = this.equipment.scale.x;
    if (Math.abs(scale - (this.lastReportedScale ?? -1)) < 0.001) return;
    this.lastReportedScale = scale;
    this.onScale(scale);
  }

  /** Alterna vista montada/explodida. Devolve {explodable, exploded}. */
  toggleExplode() {
    if (!this.explode?.explodable) return { explodable: false, exploded: false };
    // Explodir com a porta aberta jogaria a folha de lado: a direção da
    // explosão é local ao pivô da dobradiça, que está girado.
    this.panel?.closeDoor();
    const exploded = this.explode.toggle();
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
    this.onPlaced(this.explode?.explodable ?? false);

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
        this.explode?.update(delta);
        this.panel?.update(delta);
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
    this.explode = null;
    this.panel = null;
    this.handProvider?.dispose();
    this.handProvider = null;

    this.hitTestSource?.cancel?.();
    this.hitTestSource = null;
    this.detachAnchor();

    disposeObject(this.equipment);
    disposeObject(this.reticle);
    this.equipment = null;
    this.selectionIndicator = null;

    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.scene = null;
    this.session = null;

    this.awaitingPlacement = true;
    this.selected = false;
    this.occlusionLive = false;
    this.onEnd();
  }
}
