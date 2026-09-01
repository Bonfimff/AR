/**
 * Registro de modelos 3D.
 *
 * `DEFAULT_MODEL_ID` é o equipamento âncora da cena — o que se posiciona
 * primeiro e serve de referência. Os demais entram pelo catálogo (`addable`),
 * e são os elementos que o usuário vai espalhando pela instalação.
 *
 * Acrescentar um elemento é uma entrada aqui mais um GLB em /models. O
 * comportamento (o que é clicável, o que acende, qual o esquema elétrico
 * local) viaja DENTRO do GLB, em `extras` — ver tools/glb.mjs. Nenhum nome de
 * peça aparece no código do app.
 */
export const MODELS = {
  equipamento: {
    url: "models/equipamento.glb",
    label: "Quadro elétrico",
    icon: "🗄️",
    // Dimensões REAIS do equipamento, em metros. A escala da cena vem daqui e
    // não do tamanho arbitrário com que o GLB foi exportado — trocar o arquivo
    // por outro modelado em qualquer unidade continua dando o tamanho certo.
    // Envelope externo real, com a maçaneta inclusa (o corpo do gabinete tem
    // 0,40 m de profundidade; a maçaneta projeta ~7 cm à frente).
    dimensions: { width: 0.8, height: 2.0, depth: 0.47 },
    fitToDimensions: true,
    // O caminho do GLB não muda quando o modelo muda, então o navegador serve
    // a versão antiga do cache. Incremente ao substituir o arquivo.
    connect: [0, 1.95, 0], // topo do gabinete: é por onde a eletrocalha entra
    version: 7, // v7: disjuntores D1/D2/D3, sem geral
  },

  // --- catálogo: elementos que o usuário acrescenta à instalação ----------
  // Estes NÃO usam fitToDimensions: já são gerados em metros reais por
  // tools/make-elements-glb.mjs. Reescalar seria reintroduzir um erro que a
  // geração procedural não tem.
  tomada: {
    url: "models/tomada.glb",
    label: "Tomada",
    icon: "🔌",
    addable: true,
    dimensions: { width: 0.09, height: 0.09, depth: 0.018 },
    fitToDimensions: false,
    // Onde o eletroduto encosta, em coordenadas locais do elemento. Sem isto o
    // trecho miraria o centro da caixa envolvente, que numa luminária de teto
    // fica no meio do difusor e num quadro de 2 m fica na altura da cintura.
    connect: [0, 0.09, 0],
    version: 1,
  },
  interruptor: {
    url: "models/interruptor.glb",
    label: "Interruptor",
    icon: "💡",
    addable: true,
    dimensions: { width: 0.09, height: 0.09, depth: 0.02 },
    fitToDimensions: false,
    connect: [0, 0.09, 0],
    version: 1,
  },
  luminaria: {
    url: "models/luminaria.glb",
    label: "Luminária",
    icon: "🔆",
    addable: true,
    dimensions: { width: 0.24, height: 0.18, depth: 0.24 },
    fitToDimensions: false,
    connect: [0, 0.19, 0], // canopla, no teto
    version: 1,
  },
  eletroduto: {
    url: "models/eletroduto.glb",
    label: "Eletroduto",
    icon: "➖",
    // NÃO entra no catálogo comum: eletroduto não se "coloca", se traça de um
    // ponto a outro. Ver o modo A→B em src/ar-experience.js.
    dimensions: { width: 1.0, height: 0.032, depth: 0.032 },
    fitToDimensions: false,
    // O modelo tem 1 m ao longo de X e é esticado até o comprimento pedido.
    stretchAxis: "x",
    nominalLength: 1.0,
    version: 2,
  },
  curva90: {
    url: "models/curva90.glb",
    label: "Curva 90°",
    icon: "⌐",
    addable: true,
    dimensions: { width: 0.13, height: 0.04, depth: 0.13 },
    fitToDimensions: false,
    connect: [0, 0.0125, 0], // o vértice, onde os trechos chegam
    version: 1,
  },
  curva45: {
    url: "models/curva45.glb",
    label: "Curva 45°",
    icon: "◿",
    addable: true,
    dimensions: { width: 0.21, height: 0.04, depth: 0.09 },
    fitToDimensions: false,
    connect: [0, 0.0125, 0],
    version: 1,
  },
};

export const DEFAULT_MODEL_ID = "equipamento";

/** Elementos oferecidos no catálogo, na ordem de declaração. */
export const CATALOG = Object.entries(MODELS)
  .filter(([, model]) => model.addable)
  .map(([id, model]) => ({ id, label: model.label, icon: model.icon }));

export function getModel(id = DEFAULT_MODEL_ID) {
  const model = MODELS[id];
  if (!model) throw new Error(`Modelo desconhecido: "${id}"`);
  return model;
}
