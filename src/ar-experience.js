import * as THREE from "three";
import { loadEquipment, createSelectionIndicator, disposeObject } from "./equipment.js";
import { GestureController } from "./gestures.js";
import { DEPTH_SENSING_INIT, inspectDepthSensing, isOcclusionLive } from "./occlusion.js";
import { getModel } from "./models.js";

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
  constructor({ modelId, overlayRoot, gestureLayer, onStatus, onPlaced, onDepthStatus, onEnd }) {
    this.model = getModel(modelId);
    this.overlayRoot = overlayRoot;
    this.gestureLayer = gestureLayer;
    this.onStatus = onStatus;
    this.onPlaced = onPlaced;
    this.onDepthStatus = onDepthStatus;
    this.onEnd = onEnd;

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
  }

  async start() {
    this.buildScene();

    // Pré-carrega o modelo para que a colocação seja instantânea.
    const modelPromise = loadEquipment(this.model.url);

    this.session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "local"],
      optionalFeatures: ["anchors", "dom-overlay", "depth-sensing"],
      domOverlay: { root: this.overlayRoot },
      depthSensing: DEPTH_SENSING_INIT,
    });

    this.overlayActive = this.session.domOverlayState?.type === "screen";
    this.anchorsSupported =
      typeof XRHitTestResult !== "undefined" && "createAnchor" in XRHitTestResult.prototype;

    this.session.addEventListener("end", () => this.cleanup());
    this.renderer.xr.setReferenceSpaceType("local");
    await this.renderer.xr.setSession(this.session);

    this.depthStatus = inspectDepthSensing(this.session, this.renderer);
    console.info("[AR] depth-sensing:", this.depthStatus);
    this.onDepthStatus?.(this.depthStatus);

    this.referenceSpace = this.renderer.xr.getReferenceSpace();
    this.viewerSpace = await this.session.requestReferenceSpace("viewer");
    this.hitTestSource = await this.session.requestHitTestSource({ space: this.viewerSpace });

    try {
      this.equipment = await modelPromise;
      this.selectionIndicator = createSelectionIndicator(this.equipment);
    } catch (error) {
      this.onStatus(`Falha ao carregar ${this.model.url}.`);
      console.error(error);
    }

    this.setupInput();
    this.onStatus("Aponte para uma superfície e toque para posicionar");
    this.renderer.setAnimationLoop((time, frame) => this.render(time, frame));
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
    if (hitObject) this.setSelected(true);
    else if (this.selected) this.setSelected(false);
  }

  raycastEquipment(clientX, clientY) {
    const camera = this.getXRCamera();
    if (!camera) return false;
    const rect = this.gestureLayer.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this._ndc, camera);
    return this.raycaster.intersectObject(this.equipment, true).length > 0;
  }

  setSelected(selected) {
    if (this.selected === selected) return;
    this.selected = selected;
    if (this.selectionIndicator) this.selectionIndicator.visible = selected;
    this.gestures?.setTarget(selected ? this.equipment : null);

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
    this.onStatus("Aponte para uma superfície e toque para posicionar");
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
    if (this.equipment.parent !== this.anchorGroup) this.anchorGroup.add(this.equipment);

    this.onStatus(this.hasInteracted ? "" : "Toque no objeto para manipular");
    this.onPlaced();

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
    const delta = this.lastFrameTime ? Math.min((time - this.lastFrameTime) / 1000, 0.1) : 0;
    this.lastFrameTime = time;

    if (frame) {
      if (this.awaitingPlacement) {
        // O hit-test só é consultado enquanto há algo a posicionar.
        const results = this.hitTestSource ? frame.getHitTestResults(this.hitTestSource) : [];
        const pose = results[0]?.getPose(this.referenceSpace);
        this.reticle.visible = Boolean(pose);
        if (pose) {
          this.reticle.matrix.fromArray(pose.transform.matrix);
          if (this.placementRequested) this.place(results[0], pose);
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
      }

      // A textura de profundidade só chega alguns frames depois do início.
      if (!this.occlusionLive && isOcclusionLive(this.renderer)) {
        this.occlusionLive = true;
        this.onDepthStatus?.({ ...this.depthStatus, active: true, live: true });
      }
    }

    this.renderer.render(this.scene, this.camera);
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
