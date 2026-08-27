/**
 * Registro de modelos 3D.
 *
 * Hoje a experiência carrega apenas um modelo (DEFAULT_MODEL_ID). O registro
 * existe para que adicionar novos equipamentos seja só acrescentar uma entrada
 * aqui e um GLB em /models — sem catálogo, sem backend, sem UI de seleção.
 *
 * Exemplo de expansão futura:
 *   nobreak: { url: "models/nobreak.glb", label: "Nobreak" },
 *   rack:    { url: "models/rack.glb",    label: "Rack 42U" },
 *   camera:  { url: "models/camera.glb",  label: "Câmera IP" },
 */
export const MODELS = {
  equipamento: {
    url: "models/equipamento.glb",
    label: "Equipamento",
  },
};

export const DEFAULT_MODEL_ID = "equipamento";

export function getModel(id = DEFAULT_MODEL_ID) {
  const model = MODELS[id];
  if (!model) throw new Error(`Modelo desconhecido: "${id}"`);
  return model;
}
