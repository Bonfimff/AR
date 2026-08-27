import * as THREE from "three";
import { loadEquipment, disposeObject } from "./equipment.js";
import { GestureController } from "./gestures.js";

/**
 * Sessão WebXR immersive-ar: hit-test para achar a superfície, âncora espacial
 * para manter o objeto fixo no mundo real e gestos para ajustá-lo.
 */
export class ARExperience {
  constructor({ modelUrl, overlayRoot, gestureLayer, onStatus, onPlaced, onEnd }) {
    this.modelUrl = modelUrl;
    this.overlayRoot = overlayRoot;
    this.gestureLayer = gestureLayer;
    this.onStatus = onStatus;
    this.onPlaced = onPlaced;
    this.onEnd = onEnd;

    this.session = null;
    this.equipment = null;
    this.anchor = null;
    this.placementRequested = false;
    this.awaitingPlacement = true;
  }

  async start() {
    this.buildScene();

    // Pré-carrega o modelo para que a colocação seja instantânea.
    const modelPromise = loadEquipment(this.modelUrl);

    this.session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "local"],
      optionalFeatures: ["anchors", "dom-overlay"],
      domOverlay: { root: this.overlayRoot },
    });

    this.overlayActive = this.session.domOverlayState?.type === "screen";
    this.anchorsSupported =
      typeof XRHitTestResult !== "undefined" && "createAnchor" in XRHitTestResult.prototype;

    this.session.addEventListener("end", () => this.cleanup());
    this.renderer.xr.setReferenceSpaceType("local");
    await this.renderer.xr.setSession(this.session);

    this.referenceSpace = this.renderer.xr.getReferenceSpace();
    this.viewerSpace = await this.session.requestReferenceSpace("viewer");
    this.hitTestSource = await this.session.requestHitTestSource({ space: this.viewerSpace });

    try {
      this.equipment = await modelPromise;
    } catch (error) {
      this.onStatus("Falha ao carregar models/equipamento.glb.");
      console.error(error);
    }

    this.setupInput();
    this.onStatus("Aponte para uma superfície e toque para posicionar");
    this.renderer.setAnimationLoop((time, frame) => this.render(frame));
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

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00e0a4, transparent: true, opacity: 0.9 })
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    // Recebe a pose da âncora; o equipamento é seu filho e guarda os ajustes do usuário.
    this.anchorGroup = new THREE.Group();
    this.anchorGroup.visible = false;
    this.scene.add(this.anchorGroup);

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
        onTap: () => this.requestPlacement(),
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

  requestPlacement() {
    if (this.awaitingPlacement && this.equipment) this.placementRequested = true;
  }

  reposition() {
    this.awaitingPlacement = true;
    this.placementRequested = false;
    this.anchorGroup.visible = false;
    this.detachAnchor();
    this.gestures?.setTarget(null);
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

    if (this.equipment.parent !== this.anchorGroup) {
      this.equipment.position.set(0, 0, 0);
      this.equipment.rotation.set(0, 0, 0);
      this.equipment.scale.setScalar(1);
      this.anchorGroup.add(this.equipment);
    }

    this.gestures?.setTarget(this.equipment);
    this.onStatus("");
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

  render(frame) {
    if (frame) {
      const results = this.hitTestSource ? frame.getHitTestResults(this.hitTestSource) : [];

      if (this.awaitingPlacement) {
        const pose = results[0]?.getPose(this.referenceSpace);
        this.reticle.visible = Boolean(pose);
        if (pose) {
          this.reticle.matrix.fromArray(pose.transform.matrix);
          if (this.placementRequested) this.place(results[0], pose);
        }
      } else if (this.anchor) {
        // A âncora é reajustada pelo ARCore conforme o mapa do ambiente evolui.
        const anchorPose = frame.getPose(this.anchor.anchorSpace, this.referenceSpace);
        if (anchorPose) {
          const p = anchorPose.transform.position;
          this.anchorGroup.position.set(p.x, p.y, p.z);
        }
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

    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.scene = null;
    this.session = null;

    this.awaitingPlacement = true;
    this.onEnd();
  }
}
