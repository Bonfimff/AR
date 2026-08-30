/**
 * Indicação visual dos gestos: qual manipulação está ativa agora, e uma
 * legenda única explicando o vocabulário de gestos da mão.
 *
 * Toque e mão convergem para os mesmos quatro modos de manipulação (mover /
 * altura / girar / escala) — ver README para o porquê de cada limiar. Esta
 * classe só traduz o modo atual em um rótulo curto; a decisão de qual modo
 * está ativo continua inteira em HandController e GestureController.
 */

const MODE_LABELS = {
  selected: "🤏 Selecionado",
  move: "↔ Movendo",
  height: "↕ Altura",
  rotate: "⟳ Girando",
  scale: "⤢ Escala",
};

// "Selecionado" é transitório: se nenhum eixo travar em seguida, ele some
// sozinho em vez de ficar preso na tela.
const SELECTED_TIMEOUT_MS = 1400;

const HINT_STORAGE_KEY = "ar-hand-gesture-hint-v1";

export class GestureHud {
  constructor({ badgeEl, legendEl, legendCloseEl }) {
    this.badgeEl = badgeEl;
    this.legendEl = legendEl;
    this._selectedTimer = null;

    legendCloseEl?.addEventListener("click", () => this.hideHandLegend());
  }

  /** @param {'selected'|'move'|'height'|'rotate'|'scale'|null} mode */
  showMode(mode) {
    clearTimeout(this._selectedTimer);
    if (!mode || !MODE_LABELS[mode]) {
      this.badgeEl.hidden = true;
      return;
    }
    this.badgeEl.hidden = false;
    this.badgeEl.textContent = MODE_LABELS[mode];
    if (mode === "selected") {
      this._selectedTimer = setTimeout(() => {
        this.badgeEl.hidden = true;
      }, SELECTED_TIMEOUT_MS);
    }
  }

  /** Mostra a legenda de gestos da mão uma única vez neste aparelho. */
  maybeShowHandLegend() {
    try {
      if (localStorage.getItem(HINT_STORAGE_KEY)) return;
    } catch {
      /* localStorage indisponível (modo privado): mostra mesmo assim */
    }
    this.legendEl.hidden = false;
  }

  hideHandLegend() {
    this.legendEl.hidden = true;
    try {
      localStorage.setItem(HINT_STORAGE_KEY, "1");
    } catch {
      /* modo privado: a legenda volta a aparecer na próxima sessão, sem quebrar nada */
    }
  }

  dispose() {
    clearTimeout(this._selectedTimer);
  }
}
