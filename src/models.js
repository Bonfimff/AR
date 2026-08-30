/**
 * Registro de modelos 3D.
 *
 * Hoje a experiência carrega apenas um modelo (DEFAULT_MODEL_ID). O registro
 * existe para que adicionar novos equipamentos seja só acrescentar uma entrada
 * aqui e um GLB em /models — sem catálogo, sem backend, sem UI de seleção.
 *
 * Exemplo de expansão futura:
 *   nobreak: { url: "models/nobreak.glb", label: "Nobreak",
 *              dimensions: { width: 0.4, height: 0.9, depth: 0.7 }, fitToDimensions: true },
 *   rack:    { url: "models/rack.glb",    label: "Rack 42U",
 *              dimensions: { width: 0.6, height: 2.0, depth: 1.0 }, fitToDimensions: true },
 */
export const MODELS = {
  equipamento: {
    url: "models/equipamento.glb",
    label: "Quadro elétrico",
    // Dimensões REAIS do equipamento, em metros. A escala da cena vem daqui e
    // não do tamanho arbitrário com que o GLB foi exportado — trocar o arquivo
    // por outro modelado em qualquer unidade continua dando o tamanho certo.
    // Envelope externo real, com a maçaneta inclusa (o corpo do gabinete tem
    // 0,40 m de profundidade; a maçaneta projeta ~7 cm à frente).
    dimensions: { width: 0.8, height: 2.0, depth: 0.47 },
    fitToDimensions: true,
    // O caminho do GLB não muda quando o modelo muda, então o navegador serve
    // a versão antiga do cache. Incremente ao substituir o arquivo.
    version: 5, // v5: disjuntores clicáveis, dobradiça e esquema elétrico embutido
  },
};

export const DEFAULT_MODEL_ID = "equipamento";

export function getModel(id = DEFAULT_MODEL_ID) {
  const model = MODELS[id];
  if (!model) throw new Error(`Modelo desconhecido: "${id}"`);
  return model;
}
