/**
 * Gera os demais elementos da instalação elétrica, um GLB por tipo:
 *
 *   models/tomada.glb        tomada 2P+T de parede
 *   models/interruptor.glb   interruptor simples (a tecla é acionável)
 *   models/luminaria.glb     luminária de teto
 *   models/eletroduto.glb    trecho reto de eletroduto
 *
 * Todos procedurais, pelo mesmo motivo do quadro: modelo próprio, sem dúvida
 * de licença. Compartilham o construtor em tools/glb.mjs.
 *
 * CADA ARQUIVO CARREGA O PRÓPRIO ESQUEMA ELÉTRICO em `scene.extras.circuits`,
 * descrevendo só os elementos que ele contém — sem fonte e sem disjuntor. A
 * ligação com o quadro é feita em runtime, quando o usuário associa a carga a
 * um circuito, e os ids ganham prefixo por instância para não colidirem quando
 * a mesma tomada for colocada cinco vezes.
 *
 * Uso: node tools/make-elements-glb.mjs
 */
import { createBuilder } from "./glb.mjs";

// Paleta comum. Repetida em cada elemento porque um GLB é autocontido — o
// custo é irrisório (uma dúzia de floats) e evita um arquivo de material
// compartilhado que o glTF teria de referenciar externamente.
const PALETTE = [
  { name: "Placa", color: [0.94, 0.94, 0.95, 1], metallic: 0.05, roughness: 0.45 },
  { name: "Tecla", color: [0.88, 0.88, 0.90, 1], metallic: 0.05, roughness: 0.5 },
  { name: "Furo", color: [0.10, 0.10, 0.12, 1], metallic: 0.1, roughness: 0.8 },
  // metallic baixo DE PROPÓSITO: a cena não tem environment map, e metal
  // muito metálico não tem o que refletir — renderiza quase preto. Vale em AR
  // tanto quanto no teste. Estes elementos são metal pintado, não polido.
  { name: "Metal", color: [0.70, 0.72, 0.74, 1], metallic: 0.25, roughness: 0.45 },
  { name: "Conduite", color: [0.92, 0.92, 0.94, 1], metallic: 0.05, roughness: 0.6 },
  // Vidro/difusor da luminária: a cor e o emissive são reescritos em runtime
  // conforme o circuito (ver src/panel.js), aqui vale só o acabamento.
  { name: "Difusor", color: [0.95, 0.93, 0.82, 1], metallic: 0, roughness: 0.2, emissive: [0.55, 0.52, 0.36] },
  { name: "Marcador", color: [0.13, 0.77, 0.37, 1], metallic: 0, roughness: 0.3, emissive: [0.06, 0.35, 0.17] },
];

const results = [];

/**
 * @param {string} name    arquivo de saída
 * @param {Function} build recebe as ferramentas do construtor
 * @param {Array} elements esquema elétrico local do elemento
 */
function make(name, build, elements) {
  const b = createBuilder({ materials: PALETTE, generator: `${name}-procedural` });
  build(b);
  const out = b.write(`models/${name}.glb`, { circuits: { version: 1, elements } });
  results.push({ name, ...out });
}

// ---------------------------------------------------------------- tomada
// 2P+T de embutir, na altura de tomada baixa. A geometria fica com a base em
// y=0 e centrada em X/Z porque loadEquipment normaliza assim de qualquer forma.
make(
  "tomada",
  ({ M, box, cylinder, declare }) => {
    declare("Tomada", { extras: { circuitId: "carga" } });
    box("Tomada", M.Placa, [0, 0.045, 0], [0.09, 0.09, 0.012]);
    // espelho levemente saliente
    box("Tomada", M.Placa, [0, 0.045, 0.008], [0.07, 0.07, 0.006]);
    // dois polos + terra
    cylinder("Tomada", M.Furo, [-0.014, 0.052, 0.012], 0.0055, 0.006, "z");
    cylinder("Tomada", M.Furo, [0.014, 0.052, 0.012], 0.0055, 0.006, "z");
    cylinder("Tomada", M.Furo, [0, 0.030, 0.012], 0.0055, 0.006, "z");

    // Marcador de energização: a tomada não tem parte móvel que denuncie o
    // estado, então sem ele "sem energia" seria invisível.
    const marker = declare("Marc-tomada", { parent: "Tomada", extras: { role: "marker" } });
    box(marker, M.Marcador, [0, 0.072, 0.013], [0.028, 0.008, 0.004]);
  },
  [{ id: "carga", kind: "outlet", label: "Tomada", feeds: [] }]
);

// ---------------------------------------------------------------- interruptor
// A TECLA é o elemento manobrável: é ela que carrega o circuitId, para que
// tocar na tecla (e não na placa) acione. Ver handlePick em src/panel.js, que
// sobe pela hierarquia — tocar na placa também funciona, pois a tecla é filha.
make(
  "interruptor",
  ({ M, box, declare }) => {
    declare("Interruptor", {});
    box("Interruptor", M.Placa, [0, 0.045, 0], [0.09, 0.09, 0.012]);

    const key = declare("Tecla", { parent: "Interruptor", extras: { circuitId: "chave", role: "lever" } });
    box(key, M.Tecla, [0, 0.045, 0.009], [0.045, 0.062, 0.008]);

    const marker = declare("Marc-interruptor", { parent: key, extras: { role: "marker" } });
    box(marker, M.Marcador, [0, 0.022, 0.014], [0.02, 0.006, 0.004]);
  },
  [{ id: "chave", kind: "switch", label: "Interruptor", feeds: [] }]
);

// ---------------------------------------------------------------- luminária
make(
  "luminaria",
  ({ M, box, cylinder, declare }) => {
    declare("Luminaria", {});
    // canopla e haste
    cylinder("Luminaria", M.Metal, [0, 0.17, 0], 0.045, 0.02, "y");
    cylinder("Luminaria", M.Metal, [0, 0.11, 0], 0.008, 0.11, "y");
    // Prato circular, não quadrado: uma chapa quadrada escura lia como caixa
    // solta no teto em vez de luminária.
    cylinder("Luminaria", M.Metal, [0, 0.052, 0], 0.13, 0.014, "y", 20);

    // O difusor é a peça que acende: nó próprio com circuitId, material
    // clonado em runtime para acender/apagar sozinho.
    const glass = declare("Difusor", { parent: "Luminaria", extras: { circuitId: "carga" } });
    cylinder(glass, M.Difusor, [0, 0.025, 0], 0.105, 0.05, "y");
  },
  [{ id: "carga", kind: "lamp", label: "Luminária", feeds: [] }]
);

// ---------------------------------------------------------------- eletroduto
// Trecho reto de 1 m com luvas nas pontas. O comprimento real é ajustado pela
// escala do elemento na cena — um eletroduto de 2,5 m é este modelo com
// escala 2,5 no eixo do tubo. Sem circuito: é infraestrutura, não carga.
make(
  "eletroduto",
  ({ M, cylinder, declare }) => {
    declare("Eletroduto", {});
    cylinder("Eletroduto", M.Conduite, [0, 0.0125, 0], 0.0125, 1.0, "x", 10);
    cylinder("Eletroduto", M.Metal, [-0.48, 0.0125, 0], 0.016, 0.04, "x", 10);
    cylinder("Eletroduto", M.Metal, [0.48, 0.0125, 0], 0.016, 0.04, "x", 10);
  },
  []
);

for (const r of results) {
  console.log(
    `models/${r.name}.glb — ${r.nodes.length} nós, ${r.triangles} triângulos, ` +
      `${(r.bytes / 1024).toFixed(1)} KB`
  );
}
