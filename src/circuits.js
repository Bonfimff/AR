/**
 * Modelo elétrico — dado puro, sem THREE.js e sem DOM.
 *
 * Esta é a fonte da verdade sobre o que está energizado. O 3D apenas ASSINA o
 * resultado (ver onChange) e traduz em cor/emissive; nenhuma decisão elétrica
 * mora na cena. Duas razões concretas para essa separação:
 *
 *  - testabilidade: roda em Node, sem celular e sem sessão AR — é a única
 *    parte do sistema que dá para verificar de verdade sem hardware, e é
 *    justamente onde errar custa caro (mostrar como morto um circuito vivo
 *    desacredita a ferramenta inteira);
 *  - portabilidade: se um dia o projeto virar app nativo, isto atravessa
 *    intacto. O código de WebXR/Three.js, não.
 *
 * A topologia é um grafo dirigido: cada elemento "alimenta" (feeds) outros.
 * Não é uma árvore — interruptor paralelo (three-way) e alimentação por dois
 * caminhos formam ciclos legítimos, e a propagação lida com eles.
 */

/** Tipos de elemento. `switchable: true` = pode abrir/fechar o caminho. */
export const KIND = {
  /** Entrada de energia (ramal/alimentação). Sempre energizada. */
  source: { switchable: false, source: true },
  /** Disjuntor. */
  breaker: { switchable: true, source: false },
  /** Interruptor de parede. */
  switch: { switchable: true, source: false },
  /** Tomada. */
  outlet: { switchable: false, source: false },
  /** Luminária. */
  lamp: { switchable: false, source: false },
  /** Caixa de passagem / emenda: só conduz. */
  junction: { switchable: false, source: false },
};

export class CircuitModel {
  constructor() {
    /** @type {Map<string, {id, kind, label, feeds: string[], closed: boolean}>} */
    this.elements = new Map();
    this.energized = new Set();
    this.onChange = null;
    this._dirty = true;
  }

  /**
   * @param {{id: string, kind: keyof KIND, label?: string, feeds?: string[],
   *          closed?: boolean}} spec
   */
  add(spec) {
    const { id, kind } = spec;
    if (!id) throw new Error("Elemento sem id");
    if (!KIND[kind]) throw new Error(`Tipo desconhecido: "${kind}" (${id})`);
    if (this.elements.has(id)) throw new Error(`Id duplicado: "${id}"`);

    this.elements.set(id, {
      id,
      kind,
      label: spec.label ?? id,
      feeds: [...(spec.feeds ?? [])],
      // Disjuntor/interruptor nascem fechados (ligados); o resto conduz sempre.
      closed: spec.closed ?? true,
    });
    this._dirty = true;
    return this;
  }

  /** Liga a saída de `fromId` à entrada de `toId`. */
  connect(fromId, toId) {
    const from = this.require(fromId);
    this.require(toId);
    if (!from.feeds.includes(toId)) from.feeds.push(toId);
    this._dirty = true;
    return this;
  }

  require(id) {
    const element = this.elements.get(id);
    if (!element) throw new Error(`Elemento inexistente: "${id}"`);
    return element;
  }

  get(id) {
    return this.elements.get(id) ?? null;
  }

  /**
   * Abre/fecha um disjuntor ou interruptor. Devolve o novo estado.
   * Chamar em elemento não-manobrável é erro de programação, não um no-op
   * silencioso: significa que a cena marcou como clicável algo que não é.
   */
  setClosed(id, closed) {
    const element = this.require(id);
    if (!KIND[element.kind].switchable) {
      throw new Error(`"${id}" (${element.kind}) não é manobrável`);
    }
    if (element.closed === closed) return closed;
    element.closed = closed;
    this._dirty = true;
    this.solve();
    return closed;
  }

  toggle(id) {
    return this.setClosed(id, !this.require(id).closed);
  }

  /**
   * Remove um elemento E toda referência a ele. Sem a segunda parte, apagar
   * uma luminária deixaria o interruptor alimentando um id inexistente, que
   * validate() passaria a acusar para sempre.
   */
  remove(id) {
    if (!this.elements.delete(id)) return false;
    for (const element of this.elements.values()) {
      const at = element.feeds.indexOf(id);
      if (at >= 0) element.feeds.splice(at, 1);
    }
    this._dirty = true;
    this.solve();
    return true;
  }

  /** Quem alimenta `id` diretamente. */
  feedersOf(id) {
    const feeders = [];
    for (const element of this.elements.values()) {
      if (element.feeds.includes(id)) feeders.push(element.id);
    }
    return feeders;
  }

  /**
   * Desliga todas as entradas de `id`. É metade de "reassociar": uma carga
   * alimentada por dois circuitos ao mesmo tempo seria um erro de instalação,
   * não uma redundância — então associar substitui, não acumula.
   */
  clearFeedsInto(id) {
    for (const element of this.elements.values()) {
      const at = element.feeds.indexOf(id);
      if (at >= 0) element.feeds.splice(at, 1);
    }
    this._dirty = true;
    this.solve();
  }

  /**
   * Recalcula quem recebe tensão, a partir das fontes.
   *
   * Distinção que importa para um eletricista: um disjuntor DESLIGADO continua
   * energizado no lado de entrada — ele só não passa adiante. Por isso o
   * elemento entra em `energized` ao ser alcançado, mas só propaga se estiver
   * fechado. Tratar os dois como a mesma coisa mostraria o barramento como
   * morto sempre que o disjuntor caísse, que é exatamente o engano perigoso.
   */
  solve() {
    const before = this.energized;
    const energized = new Set();

    // Busca em largura a partir de todas as fontes. O `visited` é o que impede
    // laço infinito num paralelo (dois interruptores alimentando a mesma
    // lâmpada por caminhos distintos) — topologia legítima, não erro.
    const queue = [];
    for (const element of this.elements.values()) {
      if (KIND[element.kind].source) queue.push(element);
    }

    while (queue.length) {
      const element = queue.shift();
      if (energized.has(element.id)) continue;
      energized.add(element.id);

      // Manobrável e aberto: recebe tensão, mas não entrega.
      if (KIND[element.kind].switchable && !element.closed) continue;

      for (const nextId of element.feeds) {
        const next = this.elements.get(nextId);
        // Referência solta (elemento apagado sem limpar o feeds): ignora aqui
        // e deixa validate() reportar, em vez de derrubar o render.
        if (next && !energized.has(nextId)) queue.push(next);
      }
    }

    this.energized = energized;
    this._dirty = false;
    if (!sameSet(before, energized)) this.onChange?.(this);
    return energized;
  }

  /** Recebe tensão? (um disjuntor desligado ainda recebe — ver solve()). */
  isEnergized(id) {
    if (this._dirty) this.solve();
    return this.energized.has(id);
  }

  /**
   * Está de fato funcionando? Para lâmpada = acesa, para tomada = com energia
   * disponível. É o que a cena 3D deve usar para acender/apagar. Difere de
   * isEnergized só nos manobráveis.
   */
  isLive(id) {
    const element = this.require(id);
    if (!this.isEnergized(id)) return false;
    return KIND[element.kind].switchable ? element.closed : true;
  }

  /** Ids alimentados por `id`, direta ou indiretamente. Para "o que esse disjuntor controla?". */
  downstreamOf(id) {
    this.require(id);
    const seen = new Set();
    const queue = [...this.require(id).feeds];
    while (queue.length) {
      const nextId = queue.shift();
      if (seen.has(nextId) || nextId === id) continue;
      const next = this.elements.get(nextId);
      if (!next) continue;
      seen.add(nextId);
      queue.push(...next.feeds);
    }
    return seen;
  }

  /**
   * Problemas de montagem que valem avisar ao usuário. Não lança: uma planta
   * em construção passa a maior parte do tempo incompleta, e travar a cada
   * elemento solto tornaria a ferramenta inutilizável.
   */
  validate() {
    const problems = [];
    let sources = 0;

    for (const element of this.elements.values()) {
      if (KIND[element.kind].source) sources += 1;
      for (const nextId of element.feeds) {
        if (!this.elements.has(nextId)) {
          problems.push({ id: element.id, problem: "alimenta-inexistente", ref: nextId });
        }
      }
    }
    if (sources === 0) problems.push({ id: null, problem: "sem-fonte" });

    // Um elemento que nenhuma fonte alcança nunca vai funcionar, esteja tudo
    // ligado ou não. Testa com todos os manobráveis fechados para não acusar
    // de "desconectado" o que está apenas desligado no momento.
    const reachable = reachableIgnoringSwitches(this);
    for (const element of this.elements.values()) {
      if (!reachable.has(element.id)) {
        problems.push({ id: element.id, problem: "sem-alimentacao" });
      }
    }
    return problems;
  }

  /** Estado serializável — base do arquivo que o usuário vai baixar. */
  toJSON() {
    return {
      version: 1,
      elements: [...this.elements.values()].map((e) => ({
        id: e.id,
        kind: e.kind,
        label: e.label,
        feeds: [...e.feeds],
        closed: e.closed,
      })),
    };
  }

  static fromJSON(data) {
    if (!data || data.version !== 1) {
      throw new Error(`Versão de circuito não suportada: ${data?.version}`);
    }
    const model = new CircuitModel();
    // Dois passes: os elementos precisam existir antes das ligações, senão a
    // ordem do arquivo passaria a importar.
    for (const e of data.elements) {
      model.add({ id: e.id, kind: e.kind, label: e.label, closed: e.closed });
    }
    for (const e of data.elements) {
      for (const target of e.feeds ?? []) model.connect(e.id, target);
    }
    model.solve();
    return model;
  }
}

/** Alcance ignorando o estado dos manobráveis: testa a TOPOLOGIA, não a operação. */
function reachableIgnoringSwitches(model) {
  const seen = new Set();
  const queue = [];
  for (const element of model.elements.values()) {
    if (KIND[element.kind].source) queue.push(element.id);
  }
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const element = model.elements.get(id);
    if (element) queue.push(...element.feeds);
  }
  return seen;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
