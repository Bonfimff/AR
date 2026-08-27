import * as THREE from "three";

/**
 * Provider de mão via MediaPipe Hand Landmarker, alimentado pelo
 * WebXR Raw Camera Access.
 *
 * POR QUE camera-access E NÃO getUserMedia:
 * durante uma sessão immersive-ar o ARCore é dono da câmera. Abrir um segundo
 * stream com getUserMedia disputa o mesmo dispositivo e derruba a sessão AR.
 * O módulo Raw Camera Access (Chrome 107+) entrega o frame já sincronizado com
 * a pose, como textura WebGL — é o único caminho correto aqui.
 *
 * PIPELINE POR INFERÊNCIA (não por frame):
 *   textura da câmera -> blit para um render target pequeno
 *   -> readRenderTargetPixelsAsync (assíncrono, não trava a GPU)
 *   -> ImageData -> canvas -> HandLandmarker.detectForVideo
 *
 * O render target usa a MESMA proporção do viewport, então as coordenadas
 * normalizadas devolvidas pelo MediaPipe mapeiam 1:1 na tela. A imagem sai
 * levemente esticada para a inferência, o que não atrapalha os landmarks.
 */

const VISION_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Resolução da inferência. Baixa de propósito: o gargalo do celular é a leitura
// GPU->CPU, e o Hand Landmarker funciona bem nessa faixa.
const INFER_WIDTH = 256;
// Teto de inferências por segundo. A AR continua a 60 fps; só o hand tracking
// roda mais devagar, e os filtros cobrem o intervalo.
const INFER_HZ = 12;

// A leitura de pixels da GPU vem de baixo para cima (convenção do WebGL),
// enquanto ImageData é de cima para baixo. Se no aparelho os gestos saírem
// espelhados na vertical, é esta constante que se inverte.
const FLIP_Y = true;

export class MediaPipeHandProvider {
  static kind = "mediapipe";

  static isAvailable(session) {
    return Boolean(session?.enabledFeatures?.includes("camera-access"));
  }

  constructor({ renderer }) {
    this.kind = "mediapipe";
    this.renderer = renderer;
    this.landmarker = null;
    this.points = null;
    this.busy = false;
    this.lastInference = 0;
    this.lastTimestamp = 0;
    this.failure = null;

    // Diagnóstico: sem isto não dá para saber, no aparelho, se o problema é a
    // textura da câmera, a inferência ou o gesto.
    this.hasCameraTexture = false;
    this.inferences = 0;
  }

  async init() {
    try {
      const { FilesetResolver, HandLandmarker } = await import(/* @vite-ignore */ VISION_BUNDLE);
      const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.setupBlit();
      return true;
    } catch (error) {
      this.failure = error.message;
      console.error("[AR] MediaPipe indisponível:", error);
      return false;
    }
  }

  setupBlit() {
    const aspect = window.innerHeight / window.innerWidth || 0.75;
    this.width = INFER_WIDTH;
    this.height = Math.max(2, Math.round(INFER_WIDTH * aspect));

    this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blitMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
    this.blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMaterial);
    this.blitScene = new THREE.Scene();
    this.blitScene.add(this.blitMesh);

    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.imageData = new ImageData(this.width, this.height);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * Dispara uma inferência quando é hora; devolve sempre o último resultado
   * conhecido, para que o consumidor nunca fique sem dado entre inferências.
   */
  update({ xrCamera, time }) {
    if (!this.landmarker || !this.target) return null;

    const now = time * 1000;
    const dueIn = 1000 / INFER_HZ;
    if (!this.busy && now - this.lastInference >= dueIn) {
      this.lastInference = now;
      this.capture(xrCamera, now);
    }
    return this.points;
  }

  capture(xrCamera, now) {
    // ATENÇÃO: o argumento tem de ser o XRCamera do XRView (view.camera), NÃO a
    // câmera do Three.js. O renderer guarda as texturas num objeto comum
    // indexado pelo próprio XRCamera, então uma chave de outro tipo simplesmente
    // não encontra nada — e o MediaPipe nunca recebe um frame.
    const texture = xrCamera ? this.renderer.xr.getCameraTexture?.(xrCamera) : null;
    this.hasCameraTexture = Boolean(texture);
    if (!texture) return;

    this.busy = true;
    const previousTarget = this.renderer.getRenderTarget();
    this.blitMaterial.map = texture;
    this.blitMaterial.needsUpdate = true;

    // Dentro de uma sessão ativa o WebGLRenderer TROCA a câmera recebida pela
    // câmera do XR ("camera = xr.getCamera()"). Sem desligar o xr durante o
    // blit, a textura seria projetada pela câmera da AR e o recorte sairia
    // inútil. Desligamos apenas por esta passada e devolvemos em seguida.
    const xrEnabled = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.blitScene, this.blitCamera);
    this.renderer.xr.enabled = xrEnabled;
    this.renderer.setRenderTarget(previousTarget); // devolve o framebuffer do XR

    this.renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, this.width, this.height, this.pixels)
      .then(() => this.infer(now))
      .catch((error) => {
        console.warn("[AR] leitura do frame falhou:", error);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  infer(now) {
    const { width, height } = this;
    const source = this.pixels;
    const destination = this.imageData.data;

    for (let row = 0; row < height; row += 1) {
      const from = (FLIP_Y ? height - 1 - row : row) * width * 4;
      destination.set(source.subarray(from, from + width * 4), row * width * 4);
    }
    this.context.putImageData(this.imageData, 0, 0);

    // detectForVideo exige timestamps estritamente crescentes.
    const timestamp = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;

    const result = this.landmarker.detectForVideo(this.canvas, timestamp);
    this.points = result?.landmarks?.[0]?.length ? result.landmarks[0] : null;
    this.inferences += 1;
  }

  dispose() {
    this.landmarker?.close?.();
    this.landmarker = null;
    this.target?.dispose();
    this.blitMaterial?.dispose();
    this.blitMesh?.geometry?.dispose();
    this.target = null;
    this.points = null;
    this.pixels = null;
    this.imageData = null;
    this.canvas = null;
    this.context = null;
  }
}
