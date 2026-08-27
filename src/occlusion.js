import * as THREE from "three";

/**
 * Oclusão por profundidade (WebXR Depth Sensing).
 *
 * DOIS CAMINHOS, porque o dispositivo decide qual oferece:
 *
 *   gpu-optimized -> o próprio Three.js desenha um quad com renderOrder
 *                    -Infinity cujo shader escreve gl_FragDepth a partir da
 *                    textura de profundidade (WebXRDepthSensing).
 *   cpu-optimized -> o buffer chega como ArrayBuffer; subimos como textura e
 *                    fazemos a mesma escrita de gl_FragDepth aqui
 *                    (CpuDepthOcclusion abaixo).
 *
 * Pedir apenas gpu-optimized foi um erro da versão anterior: depth-sensing é uma
 * feature OPCIONAL, e uma preferência que o aparelho não atende faz a feature
 * inteira ser descartada — o painel mostrava DEPTH: UNSUPPORTED sem que desse
 * para saber se era falta de suporte ou preferência incompatível.
 *
 * FALLBACK (explícito): se nem assim a feature for concedida, a AR roda igual,
 * sem oclusão. Nenhuma simulação, nenhum recorte falso.
 */

export const DEPTH_SENSING_INIT = {
  usagePreference: ["gpu-optimized", "cpu-optimized"],
  dataFormatPreference: ["luminance-alpha", "float32"],
};

/** Lê o estado real da oclusão depois que a sessão iniciou. Não roda por frame. */
export function inspectDepthSensing(session) {
  const enabled = Boolean(session.enabledFeatures?.includes("depth-sensing"));
  const usage = enabled ? session.depthUsage : null;
  const format = enabled ? session.depthDataFormat : null;

  let reason = null;
  if (typeof XRWebGLBinding === "undefined") reason = "XRWebGLBinding indisponível";
  else if (!enabled) reason = "o dispositivo não concedeu a feature depth-sensing";

  return { enabled, usage, format, reason, gpu: usage === "gpu-optimized" };
}

export function isOcclusionLive(renderer, cpuOcclusion) {
  return Boolean(renderer?.xr?.hasDepthSensing?.() || cpuOcclusion?.active);
}

/**
 * Oclusão para o modo cpu-optimized.
 *
 * Desenha um quad de tela cheia ANTES de tudo (renderOrder -Infinity), sem
 * escrever cor, apenas profundidade: cada pixel recebe a profundidade real
 * medida pelo ARCore. O que estiver virtualmente atrás disso é descartado pelo
 * teste de profundidade — é exatamente o comportamento pedido, mão e pessoas
 * na frente escondendo o equipamento.
 */
export class CpuDepthOcclusion {
  /**
   * @param {object} [options]
   * @param {number} [options.orientation] 0..3, ver ORIENTATIONS.
   */
  constructor({ orientation = 1 } = {}) {
    this.active = false;
    this.texture = null;
    this.meters = null;

    this.uniforms = {
      depthTexture: { value: null },
      uvTransform: { value: new THREE.Matrix4() },
      // Viewport do XR em pixels do framebuffer, NÃO o tamanho do canvas: é a
      // esse retângulo que gl_FragCoord se refere dentro da sessão.
      viewport: { value: new THREE.Vector4(0, 0, 1, 1) },
      projection: { value: new THREE.Matrix4() },
      debug: { value: 0 },
      // x: inverte o Y ANTES da matriz; y: inverte o Y DEPOIS dela.
      flip: { value: new THREE.Vector2() },
    };
    this.orientation = -1;
    this.setOrientation(orientation);

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: this.uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        // ARMADILHA DO OPENGL: com GL_DEPTH_TEST desabilitado o buffer de
        // profundidade NÃO é atualizado, mesmo com depthWrite ligado. Para
        // escrever sempre, o teste fica habilitado com função ALWAYS.
        depthTest: true,
        depthFunc: THREE.AlwaysDepth,
        depthWrite: true, // é só isto que queremos deste passe
        colorWrite: false, // a cor é a imagem da câmera, não mexemos nela
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -Infinity;
    this.mesh.visible = false;
    this.mesh.name = "CpuDepthOcclusion";
  }

  /** @param {XRFrame} frame @param {XRView} view @param {THREE.Camera} camera */
  update(frame, view, camera, renderer) {
    this.active = false;
    this.mesh.visible = false;
    if (!frame || !view || !camera) return;

    const info = frame.getDepthInformation?.(view);
    if (!info || !info.data) return;

    this.upload(info);
    this.uniforms.uvTransform.value.fromArray(info.normDepthBufferFromNormView.matrix);
    this.uniforms.projection.value.copy(camera.projectionMatrix);

    if (camera.viewport) {
      this.uniforms.viewport.value.copy(camera.viewport);
    } else {
      const size = renderer.getDrawingBufferSize(_size);
      this.uniforms.viewport.value.set(0, 0, size.x, size.y);
    }

    this.mesh.visible = true;
    this.active = true;
  }

  /**
   * Convenção de orientação do mapa de profundidade.
   *
   * gl_FragCoord tem origem embaixo à esquerda; as "normalized view
   * coordinates" da spec têm origem em cima à esquerda. Só que a matriz
   * normDepthBufferFromNormView também pode carregar a rotação entre o buffer
   * do ARCore (paisagem) e a tela (retrato) — e nesse caso inverter o Y antes
   * ou depois da matriz dá resultados diferentes. Como isso varia por
   * aparelho, as quatro combinações ficam selecionáveis em runtime pelo
   * botão "D", em vez de fixadas num palpite.
   */
  setOrientation(index) {
    const next = ((index % ORIENTATIONS) + ORIENTATIONS) % ORIENTATIONS;
    if (next === this.orientation) return next;
    this.orientation = next;
    this.uniforms.flip.value.set(next & 1, (next >> 1) & 1);
    return next;
  }

  /** Pinta o mapa de profundidade por cima, para conferir alinhamento e escala. */
  setDebug(on) {
    this.uniforms.debug.value = on ? 1 : 0;
    this.mesh.material.colorWrite = Boolean(on);
    this.mesh.material.transparent = Boolean(on);
    this.mesh.material.needsUpdate = true;
  }

  /**
   * Converte o buffer bruto em metros e sobe como textura de 1 canal float.
   * Decodificar na CPU evita depender de como cada plataforma empacota o
   * formato luminance-alpha em 16 bits — a origem clássica de mapas de
   * profundidade invertidos ou fora de escala.
   */
  upload(info) {
    const count = info.width * info.height;
    if (!this.meters || this.meters.length !== count) {
      this.meters = new Float32Array(count);
      this.texture?.dispose();
      this.texture = new THREE.DataTexture(
        this.meters,
        info.width,
        info.height,
        THREE.RedFormat,
        THREE.FloatType
      );
      this.texture.minFilter = THREE.NearestFilter;
      this.texture.magFilter = THREE.NearestFilter;
      this.uniforms.depthTexture.value = this.texture;
    }

    const scale = info.rawValueToMeters;
    if (info.data.byteLength === count * 2) {
      const raw = new Uint16Array(info.data);
      for (let i = 0; i < count; i += 1) this.meters[i] = raw[i] * scale;
    } else {
      const raw = new Float32Array(info.data);
      for (let i = 0; i < count; i += 1) this.meters[i] = raw[i] * scale;
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
    this.texture = null;
    this.meters = null;
    this.active = false;
  }
}

export const ORIENTATIONS = 4;

const _size = new THREE.Vector2();

const VERTEX = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D depthTexture;
uniform mat4 uvTransform;
uniform mat4 projection;
uniform vec4 viewport;
uniform float debug;
uniform vec2 flip;
out vec4 fragColor;

void main() {
  fragColor = vec4(0.0);

  // Ver setOrientation(): a origem vertical pode precisar de conversão antes
  // da matriz, depois dela, nas duas ou em nenhuma, conforme o aparelho.
  vec2 raw = (gl_FragCoord.xy - viewport.xy) / viewport.zw;
  vec2 normView = vec2(raw.x, mix(raw.y, 1.0 - raw.y, flip.x));
  vec2 uv = (uvTransform * vec4(normView, 0.0, 1.0)).xy;
  uv.y = mix(uv.y, 1.0 - uv.y, flip.y);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragDepth = 1.0;
    return;
  }

  float meters = texture(depthTexture, uv).r;
  if (meters <= 0.0) {
    // Sem medida para este pixel: não ocluir nada é melhor do que ocluir errado.
    gl_FragDepth = 1.0;
    return;
  }

  // Metros -> profundidade em NDC, usando a mesma projeção da câmera da AR.
  float viewZ = -meters;
  float clipZ = projection[2][2] * viewZ + projection[3][2];
  float clipW = -viewZ;
  gl_FragDepth = clamp(clipZ / clipW * 0.5 + 0.5, 0.0, 1.0);

  if (debug > 0.5) {
    float n = clamp(meters / 5.0, 0.0, 1.0); // perto = vermelho, longe = verde
    fragColor = vec4(1.0 - n, n, 0.15, 0.8);
  }
}
`;
