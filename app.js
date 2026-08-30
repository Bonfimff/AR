import { ARExperience } from "./src/ar-experience.js";
import { DEFAULT_MODEL_ID } from "./src/models.js";
import { Diagnostics } from "./src/diagnostics.js";
import { GestureHud } from "./src/gesture-hud.js";

const ui = {
  startScreen: document.getElementById("start-screen"),
  startBtn: document.getElementById("start-ar-btn"),
  message: document.getElementById("support-message"),
  hud: document.getElementById("ar-hud"),
  gestureLayer: document.getElementById("gesture-layer"),
  instructions: document.getElementById("ar-instructions"),
  depthBadge: document.getElementById("depth-badge"),
  diagPanel: document.getElementById("diag-panel"),
  diagBtn: document.getElementById("diag-btn"),
  depthBtn: document.getElementById("depth-btn"),
  repositionBtn: document.getElementById("reposition-btn"),
  exitBtn: document.getElementById("exit-ar-btn"),
  gestureBadge: document.getElementById("gesture-badge"),
  gestureLegend: document.getElementById("gesture-legend"),
  gestureLegendClose: document.getElementById("gesture-legend-close"),
};

let experience = null;
let depthBadgeTimer = null;
let diagnostics = null;
let gestureHud = null;

function showMessage(text) {
  ui.message.hidden = !text;
  ui.message.textContent = text ?? "";
}

function setStatus(text) {
  ui.instructions.hidden = !text;
  ui.instructions.textContent = text ?? "";
}

/** Aviso discreto e temporário sobre o estado da oclusão por profundidade. */
function showDepthStatus(status) {
  clearTimeout(depthBadgeTimer);
  ui.depthBadge.hidden = false;
  ui.depthBadge.textContent = status.active
    ? "Oclusão por profundidade ativa"
    : status.enabled
      ? `Profundidade negociada (${status.usage})`
      : status.mask
        ? "Sem profundidade — oclusão da mão por rastreamento"
        : "Sem oclusão por profundidade";
  ui.depthBadge.classList.toggle("is-off", !status.active);
  // O visualizador serve às duas camadas que desenhamos: mapa de profundidade
  // (caminho CPU) e silhueta da mão.
  if (status.cpu || status.mask) ui.depthBtn.hidden = false;
  depthBadgeTimer = setTimeout(() => {
    ui.depthBadge.hidden = true;
  }, 4000);
}

async function checkSupport() {
  if (!window.isSecureContext) {
    return "A experiência precisa ser servida por HTTPS (ou localhost). O WebXR não é liberado em conexões inseguras.";
  }
  if (!navigator.xr) {
    return "Este navegador não implementa WebXR. Utilize o Google Chrome no Android com o Google Play Services for AR (ARCore) instalado e atualizado.";
  }
  const supported = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
  if (!supported) {
    return "Este dispositivo/navegador não oferece suporte a WebXR immersive-ar, necessário para o rastreamento espacial desta experiência.";
  }
  return null;
}

async function startAR() {
  ui.startBtn.disabled = true;
  showMessage("");

  experience = new ARExperience({
    modelId: DEFAULT_MODEL_ID,
    overlayRoot: ui.hud,
    gestureLayer: ui.gestureLayer,
    onStatus: setStatus,
    onDepthStatus: showDepthStatus,
    onDiagnostics: (data, now) => diagnostics.update(data, now),
    onGestureMode: (mode) => gestureHud.showMode(mode),
    onHandDetected: () => gestureHud.maybeShowHandLegend(),
    onPlaced: () => {
      ui.repositionBtn.hidden = false;
    },
    onEnd: () => {
      experience = null;
      clearTimeout(depthBadgeTimer);
      ui.depthBadge.hidden = true;
      diagnostics.setVisible(false);
      ui.diagBtn.classList.remove("is-on");
      ui.depthBtn.hidden = true;
      ui.depthBtn.classList.remove("is-on");
      gestureHud.showMode(null);
      ui.gestureLegend.hidden = true;
      ui.hud.hidden = true;
      ui.repositionBtn.hidden = true;
      ui.startScreen.hidden = false;
      ui.startBtn.disabled = false;
      setStatus("");
    },
  });

  ui.startScreen.hidden = true;
  ui.hud.hidden = false;
  ui.repositionBtn.hidden = true;

  try {
    await experience.start();
  } catch (error) {
    console.error(error);
    experience?.cleanup();
    experience = null;
    ui.hud.hidden = true;
    ui.startScreen.hidden = false;
    ui.startBtn.disabled = false;
    showMessage(`Não foi possível iniciar a sessão AR: ${error.message}`);
  }
}

async function init() {
  const problem = await checkSupport();
  if (problem) {
    ui.startBtn.disabled = true;
    showMessage(problem);
    return;
  }

  diagnostics = new Diagnostics(ui.diagPanel);
  gestureHud = new GestureHud({
    badgeEl: ui.gestureBadge,
    legendEl: ui.gestureLegend,
    legendCloseEl: ui.gestureLegendClose,
  });

  ui.diagBtn.addEventListener("click", () => {
    ui.diagBtn.classList.toggle("is-on", diagnostics.toggle());
  });

  ui.depthBtn.addEventListener("click", () => {
    ui.depthBtn.classList.toggle("is-on", experience?.cycleDepthDebug() ?? false);
  });

  ui.startBtn.addEventListener("click", startAR);
  ui.exitBtn.addEventListener("click", () => experience?.end());
  ui.repositionBtn.addEventListener("click", () => {
    ui.repositionBtn.hidden = true;
    experience?.reposition();
  });
}

init();
