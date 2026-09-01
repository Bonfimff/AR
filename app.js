import { ARExperience } from "./src/ar-experience.js";
import { DEFAULT_MODEL_ID, CATALOG } from "./src/models.js";
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
  addBtn: document.getElementById("add-btn"),
  removeBtn: document.getElementById("remove-btn"),
  catalog: document.getElementById("catalog"),
  catalogItems: document.getElementById("catalog-items"),
  catalogClose: document.getElementById("catalog-close"),
  conduitBtn: document.getElementById("conduit-btn"),
  assocBtn: document.getElementById("assoc-btn"),
  assoc: document.getElementById("assoc"),
  assocTitle: document.getElementById("assoc-title"),
  assocItems: document.getElementById("assoc-items"),
  assocNone: document.getElementById("assoc-none"),
  assocClose: document.getElementById("assoc-close"),
  moveBtn: document.getElementById("move-btn"),
  movePad: document.getElementById("move-pad"),
  explodeBtn: document.getElementById("explode-btn"),
  exitBtn: document.getElementById("exit-ar-btn"),
  gestureBadge: document.getElementById("gesture-badge"),
  gestureLegend: document.getElementById("gesture-legend"),
  gestureLegendClose: document.getElementById("gesture-legend-close"),
  scaleControl: document.getElementById("scale-control"),
  scaleRange: document.getElementById("scale-range"),
  scaleValue: document.getElementById("scale-value"),
};

// A barra de escala é LOGARÍTMICA: 0.2x .. 5x com 1x exatamente no meio. Numa
// barra linear, todo o intervalo de reduzir (0.2..1) ficaria espremido em 16%
// do curso e o de aumentar ocuparia o resto — reduzir seria impossível de
// ajustar com o polegar. Em log, reduzir pela metade e dobrar andam o mesmo
// tanto, que é como a escala é percebida.
const SCALE_MIN = 0.2;
const SCALE_MAX = 5;
const SLIDER_MAX = 1000;
const sliderToScale = (v) =>
  SCALE_MIN * Math.pow(SCALE_MAX / SCALE_MIN, v / SLIDER_MAX);
const scaleToSlider = (s) =>
  Math.round((Math.log(s / SCALE_MIN) / Math.log(SCALE_MAX / SCALE_MIN)) * SLIDER_MAX);

function showScale(scale) {
  ui.scaleValue.textContent = `${Math.round(scale * 100)}%`;
}

const NUDGE_METERS = 0.05;

let experience = null;
let associableId = null; // circuito associável do elemento selecionado
let depthBadgeTimer = null;
let diagnostics = null;
let gestureHud = null;

/**
 * Reflete o estado da cena nos botões. Uma função só, chamada pelo app a cada
 * mudança, em vez de cada handler mexer nos botões por conta própria — assim
 * "quais botões aparecem" tem uma resposta única e não diverge.
 */
function applySceneState(state) {
  const selected = state?.selected ?? null;
  ui.removeBtn.hidden = !selected?.removable;
  ui.explodeBtn.hidden = !selected?.explodable;
  ui.explodeBtn.classList.toggle("is-on", Boolean(selected?.exploded));
  ui.explodeBtn.textContent = selected?.exploded ? "Remontar" : "Explodir";

  // "Associar" só aparece quando há de fato o que associar: o quadro só tem
  // disjuntores, que são fonte e não se penduram em ninguém.
  ui.assocBtn.hidden = !selected?.associable;
  associableId = selected?.associable ?? null;
  ui.moveBtn.hidden = !selected;
  if (!selected) {
    ui.movePad.hidden = true;
    ui.moveBtn.classList.remove("is-on");
  }

  // Traçar eletroduto precisa de dois elementos para ligar.
  ui.conduitBtn.hidden = (state?.count ?? 0) < 2;
  ui.conduitBtn.classList.toggle("is-on", Boolean(state?.conduit));
  ui.conduitBtn.textContent = state?.conduit ? "Cancelar" : "Eletroduto";

  renderAssociation(state?.association ?? null);
}

/** Menu "a que isto responde?", montado a partir do modelo elétrico. */
function renderAssociation(assoc) {
  ui.assoc.hidden = !assoc;
  ui.assocBtn.classList.toggle("is-on", Boolean(assoc));
  if (!assoc) return;

  ui.assocTitle.textContent =
    assoc.kind === "switch"
      ? `${assoc.label}: comandada por qual interruptor?`
      : `${assoc.label}: em qual disjuntor?`;

  ui.assocItems.replaceChildren();
  if (!assoc.options.length) {
    const empty = document.createElement("p");
    empty.className = "catalog-empty";
    empty.textContent =
      assoc.kind === "switch"
        ? "Nenhum interruptor na instalação ainda."
        : "Nenhum disjuntor na instalação ainda.";
    ui.assocItems.append(empty);
  }
  for (const option of assoc.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "catalog-item";
    button.dataset.circuitId = option.id;
    button.classList.toggle("is-current", option.id === assoc.current);
    button.textContent = option.label;
    button.addEventListener("click", () => experience?.chooseAssociation(option.id));
    ui.assocItems.append(button);
  }
  ui.assocNone.hidden = !assoc.current;
}

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
  // A profundidade fica desligada por padrão quando há máscara de mão: ela
  // recortava o equipamento sem nada na frente. Ver src/ar-experience.js.
  ui.depthBadge.textContent = status.active
    ? "Oclusão por profundidade ativa"
    : status.mask && !status.depthOn
      ? "Oclusão pela mão (profundidade desligada)"
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
    onPanelAction: (message) => gestureHud.flash(message),
    onSceneChange: (state) => applySceneState(state),
    onScale: (scale) => {
      // Vem do gesto de pinça de dois dedos; o slider só reflete, não reage.
      ui.scaleRange.value = String(scaleToSlider(scale));
      showScale(scale);
    },
    onPlaced: () => {
      ui.repositionBtn.hidden = false;
      ui.addBtn.hidden = false;
      ui.scaleControl.hidden = false;
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
      ui.addBtn.hidden = true;
      ui.addBtn.classList.remove("is-on");
      ui.removeBtn.hidden = true;
      ui.assocBtn.hidden = true;
      ui.conduitBtn.hidden = true;
      ui.moveBtn.hidden = true;
      ui.movePad.hidden = true;
      ui.assoc.hidden = true;
      closeCatalog();
      ui.explodeBtn.hidden = true;
      ui.explodeBtn.classList.remove("is-on");
      ui.scaleControl.hidden = true;
      ui.startScreen.hidden = false;
      ui.startBtn.disabled = false;
      setStatus("");
    },
  });

  ui.startScreen.hidden = true;
  ui.hud.hidden = false;
  ui.repositionBtn.hidden = true;
  ui.addBtn.hidden = true;
  ui.removeBtn.hidden = true;
  ui.assocBtn.hidden = true;
  ui.conduitBtn.hidden = true;
  ui.moveBtn.hidden = true;
  ui.movePad.hidden = true;
  ui.assoc.hidden = true;
  ui.explodeBtn.hidden = true;
  ui.scaleControl.hidden = true;
  ui.scaleRange.value = String(scaleToSlider(1));
  showScale(1);

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

/**
 * Liga a interface. Roda ANTES da checagem de suporte, e de propósito: nada
 * aqui depende de WebXR, e deixar a ligação atrás do `return` de "aparelho não
 * suportado" já custou um bug — os botões do catálogo existiam na tela sem
 * ninguém escutando o clique. Também é o que torna a UI testável num navegador
 * comum, sem sessão AR.
 */
function wireUi() {
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
    ui.addBtn.hidden = true;
    ui.removeBtn.hidden = true;
    ui.assocBtn.hidden = true;
    ui.conduitBtn.hidden = true;
    ui.moveBtn.hidden = true;
    ui.movePad.hidden = true;
    ui.assoc.hidden = true;
    ui.explodeBtn.hidden = true;
    ui.explodeBtn.classList.remove("is-on");
    ui.scaleControl.hidden = true;
    closeCatalog();
    experience?.reposition();
  });

  ui.scaleRange.addEventListener("input", () => {
    const scale = sliderToScale(Number(ui.scaleRange.value));
    showScale(scale);
    experience?.setScale(scale);
  });

  // Não mexe nos botões aqui: toggleExplode reporta o estado da cena, e
  // applySceneState é o único lugar que decide como os botões ficam.
  ui.explodeBtn.addEventListener("click", () => experience?.toggleExplode());

  // O catálogo é montado a partir de CATALOG: acrescentar um elemento em
  // src/models.js já o faz aparecer aqui, sem tocar em HTML nem em CSS.
  for (const item of CATALOG) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "catalog-item";
    button.dataset.modelId = item.id;
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.icon ?? "";
    button.append(icon, document.createTextNode(item.label));
    button.addEventListener("click", async () => {
      closeCatalog();
      await experience?.addElement(item.id);
    });
    ui.catalogItems.append(button);
  }

  ui.addBtn.addEventListener("click", () => {
    if (ui.catalog.hidden) openCatalog();
    else closeCatalog();
  });
  ui.catalogClose.addEventListener("click", closeCatalog);
  ui.removeBtn.addEventListener("click", () => experience?.removeSelected());

  // O botão sabe qual circuito abrir porque só aparece quando o elemento
  // selecionado tem exatamente um associável.
  ui.assocBtn.addEventListener("click", () => experience?.openAssociation(associableId));
  ui.conduitBtn.addEventListener("click", () => {
    if (ui.conduitBtn.classList.contains("is-on")) experience?.cancelConduit("");
    else experience?.startConduit();
  });
  ui.assocClose.addEventListener("click", () => experience?.openAssociation(null));
  ui.assocNone.addEventListener("click", () => experience?.chooseAssociation(null));

  ui.moveBtn.addEventListener("click", () => {
    const open = ui.movePad.hidden;
    ui.movePad.hidden = !open;
    ui.moveBtn.classList.toggle("is-on", open);
  });

  // Passo de 5 cm: fino o bastante para encostar uma tomada na parede, grosso
  // o bastante para atravessar um cômodo sem cansar o polegar.
  for (const button of ui.movePad.querySelectorAll(".btn-nudge")) {
    button.addEventListener("click", () => {
      experience?.nudge(button.dataset.axis, Number(button.dataset.dir) * NUDGE_METERS);
    });
  }
}

function openCatalog() {
  ui.catalog.hidden = false;
  ui.addBtn.classList.add("is-on");
}

function closeCatalog() {
  ui.catalog.hidden = true;
  ui.addBtn.classList.remove("is-on");
}

async function init() {
  wireUi();

  const problem = await checkSupport();
  if (problem) {
    ui.startBtn.disabled = true;
    showMessage(problem);
  }
}

init();
