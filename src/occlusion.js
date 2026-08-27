/**
 * Oclusão por profundidade (WebXR Depth Sensing).
 *
 * API REAL utilizada — verificada contra a implementação do Three.js r185
 * (WebXRDepthSensing) e a spec do WebXR Depth Sensing Module:
 *
 *   1. requestSession(... { depthSensing: { usagePreference, dataFormatPreference } })
 *   2. session.enabledFeatures.includes("depth-sensing")
 *   3. session.depthUsage === "gpu-optimized"
 *   4. XRWebGLBinding.getDepthInformation(view) -> textura de profundidade
 *   5. o Three.js desenha um quad com renderOrder -Infinity cujo fragment shader
 *      escreve gl_FragDepth a partir dessa textura. Tudo que for renderizado
 *      depois é testado contra a profundidade REAL do ambiente.
 *
 * Só pedimos "gpu-optimized": é o único modo que o renderer usa para oclusão.
 * Pedir "cpu-optimized" habilitaria a feature sem produzir oclusão alguma —
 * daria um falso positivo no diagnóstico.
 *
 * FALLBACK (explícito): depth-sensing entra como optionalFeature. Se o
 * dispositivo/navegador não oferecer, a sessão AR inicia normalmente e a
 * experiência segue idêntica à V1, apenas sem oclusão. NÃO há simulação por
 * visão computacional, nem recorte falso, nem plano de máscara.
 */

/** Dicionário passado ao requestSession quando pedimos depth-sensing. */
export const DEPTH_SENSING_INIT = {
  usagePreference: ["gpu-optimized"],
  dataFormatPreference: ["luminance-alpha", "float32"],
};

/**
 * Lê o estado real da oclusão após a sessão ter iniciado.
 * Nada aqui é chamado por frame.
 */
export function inspectDepthSensing(session, renderer) {
  const requested = typeof XRWebGLBinding !== "undefined";
  const enabled = Boolean(session.enabledFeatures?.includes("depth-sensing"));
  const usage = enabled ? session.depthUsage : null;
  const format = enabled ? session.depthDataFormat : null;

  // hasDepthSensing() só passa a responder true depois do primeiro frame em que
  // a textura de profundidade chega, por isso o estado final é reavaliado no loop.
  const active = enabled && usage === "gpu-optimized";

  let reason = null;
  if (!requested) reason = "XRWebGLBinding indisponível neste navegador";
  else if (!enabled) reason = "o dispositivo não expôs a feature depth-sensing";
  else if (usage !== "gpu-optimized") reason = `depthUsage retornou "${usage}"`;

  return { requested, enabled, usage, format, active, reason };
}

/** Confirma, já em runtime, se a textura de profundidade está de fato chegando. */
export function isOcclusionLive(renderer) {
  return Boolean(renderer?.xr?.hasDepthSensing?.());
}
