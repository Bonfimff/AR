/**
 * Gera models/equipamento.glb: um QUADRO ELÉTRICO industrial de piso.
 *
 * Modelo próprio, criado por geração procedural — sem dependência de asset de
 * terceiros e, portanto, sem qualquer dúvida de licença para uso no projeto.
 *
 * Dimensões reais: 0,80 m (L) x 2,00 m (A) x 0,40 m (P), incluindo o rodapé.
 *
 * ESTRUTURA EM PEÇAS (não só em materiais): cada componente lógico — porta,
 * cada disjuntor, barramentos, grelhas... — vira seu próprio nó
 * glTF, com a direção/distância da "vista explodida" gravada em
 * `node.extras.explode`. O GLTFLoader do Three.js copia `extras` para
 * `object3D.userData` automaticamente, então src/explode.js só precisa ler
 * `userData.explode` — nenhuma lista de nomes hardcoded fora do modelo.
 * Peças sem `explode` (Rodape, Vao) são o "esqueleto": ficam paradas,
 * servindo de referência enquanto o resto se afasta.
 *
 * Uso: node tools/make-panel-glb.mjs
 */
import { createBuilder } from "./glb.mjs";

const W = 0.8;
const H = 2.0;
const D = 0.4;

// --- materiais (PBR metallic-roughness) ---
const MATERIALS = [
  { name: "Corpo", color: [0.62, 0.64, 0.66, 1], metallic: 0.6, roughness: 0.45 },
  { name: "Porta", color: [0.70, 0.72, 0.74, 1], metallic: 0.55, roughness: 0.38 },
  { name: "Vao", color: [0.10, 0.11, 0.13, 1], metallic: 0.2, roughness: 0.8 },
  { name: "Ferragem", color: [0.18, 0.19, 0.21, 1], metallic: 0.85, roughness: 0.3 },
  { name: "Disjuntor", color: [0.14, 0.15, 0.17, 1], metallic: 0.05, roughness: 0.7 },
  { name: "Alavanca", color: [0.85, 0.85, 0.87, 1], metallic: 0.05, roughness: 0.6 },
  { name: "Barramento", color: [0.72, 0.45, 0.20, 1], metallic: 0.9, roughness: 0.35 },
  { name: "LampadaVerde", color: [0.10, 0.75, 0.35, 1], metallic: 0, roughness: 0.25, emissive: [0.05, 0.35, 0.15] },
  { name: "LampadaVermelha", color: [0.85, 0.15, 0.15, 1], metallic: 0, roughness: 0.25, emissive: [0.40, 0.05, 0.05] },
  { name: "LampadaAmbar", color: [0.90, 0.65, 0.10, 1], metallic: 0, roughness: 0.25, emissive: [0.40, 0.26, 0.02] },
  { name: "Placa", color: [0.90, 0.90, 0.92, 1], metallic: 0.1, roughness: 0.5 },
  // Cor definida em runtime (verde ligado / laranja desligado, ver src/panel.js);
  // aqui vale só o acabamento. Emissive != 0 para o marcador se ler mesmo na
  // penumbra do interior do gabinete.
  { name: "Marcador", color: [0.13, 0.77, 0.37, 1], metallic: 0, roughness: 0.3, emissive: [0.06, 0.35, 0.17] },
];
const { M, box, cylinder, declare, write } = createBuilder({
  materials: MATERIALS,
  generator: "quadro-eletrico-procedural",
});

// --- peças: nome -> deslocamento (m) na vista explodida. Ausente = parado. ---
const EXPLODE = {
  Fundo: [0, 0, -0.35],
  LateralEsq: [-0.35, 0, 0],
  LateralDir: [0.35, 0, 0],
  Topo: [0, 0.35, 0],
  // Rodape e Vao ficam de fora do mapa: são o esqueleto, não se movem.
  Porta: [0, 0, 0.55],
  Fileira1: [0, 0, 0.45],
  Barramentos: [-0.25, 0, 0.25],
  PrensaCabos: [0, -0.20, -0.30],
};
for (const [part, explode] of Object.entries(EXPLODE)) declare(part, { extras: { explode } });

// ---------------------------------------------------------------- construção
const PLINTH = 0.1;
const bodyH = H - PLINTH;
const bodyY = PLINTH + bodyH / 2;

// rodapé (esqueleto: não explode) e casca do corpo (explode em 4 direções)
box("Rodape", M.Ferragem, [0, PLINTH / 2, 0], [W - 0.04, PLINTH, D - 0.04]);
box("Fundo", M.Corpo, [0, bodyY, -D / 2 + 0.02], [W, bodyH, 0.04]);
box("LateralEsq", M.Corpo, [-W / 2 + 0.02, bodyY, 0], [0.04, bodyH, D]);
box("LateralDir", M.Corpo, [W / 2 - 0.02, bodyY, 0], [0.04, bodyH, D]);
box("Topo", M.Corpo, [0, H - 0.02, 0], [W, 0.04, D]);
// Fundo escuro do interior. Era uma caixa MACIÇA ocupando todo o vão — o que
// funcionava enquanto a porta nunca abria (só se via através das grelhas), mas
// engolia os disjuntores assim que a porta passou a girar. Agora é um painel
// raso, atrás dos trilhos: continua dando profundidade escura vista de fora e
// deixa o interior à mostra com a porta aberta.
box("Vao", M.Vao, [0, bodyY, -0.08], [W - 0.08, bodyH - 0.04, 0.16]);

// porta (recuada), moldura, dobradiças e maçaneta — tudo uma peça só
const doorZ = D / 2 - 0.015;
box("Porta", M.Porta, [0, bodyY, doorZ], [W - 0.06, bodyH - 0.06, 0.03]);
box("Porta", M.Ferragem, [0, bodyY + (bodyH - 0.06) / 2, doorZ], [W - 0.06, 0.012, 0.034]);
box("Porta", M.Ferragem, [0, bodyY - (bodyH - 0.06) / 2, doorZ], [W - 0.06, 0.012, 0.034]);
for (const y of [0.45, 1.0, 1.55]) {
  cylinder("Porta", M.Ferragem, [-W / 2 + 0.03, y, doorZ], 0.018, 0.09, "y");
}
box("Porta", M.Ferragem, [W / 2 - 0.10, 1.05, doorZ + 0.03], [0.05, 0.16, 0.03]);
cylinder("Porta", M.Ferragem, [W / 2 - 0.10, 1.05, doorZ + 0.07], 0.014, 0.10, "y");

// grelhas de ventilação — são RECORTES NA CHAPA DA PORTA, não peças avulsas:
// ficam em "Porta" para viajarem com ela na vista explodida. Mesmo critério da
// maçaneta e das dobradiças (ver abaixo, também em "Porta").
for (const baseY of [1.72, 0.30]) {
  for (let i = 0; i < 10; i += 1) {
    box("Porta", M.Vao, [-0.18, baseY + i * 0.014, doorZ + 0.016], [0.26, 0.006, 0.004]);
    box("Porta", M.Vao, [0.18, baseY + i * 0.014, doorZ + 0.016], [0.26, 0.006, 0.004]);
  }
}

// A porta ABRE GIRANDO, em vez de se afastar: dobradiças na aresta esquerda.
// Rotação em torno de +Y é x' = x·cos + z·sin / z' = -x·sin + z·cos, então o
// ângulo tem de ser NEGATIVO para a folha varrer para a frente (+z).
declare("Porta", {
  extras: {
    hinge: { pivot: [-W / 2 + 0.03, 0, doorZ], axis: [0, 1, 0], openDeg: -115 },
  },
});

// interior: TRÊS disjuntores grandes, lado a lado num único trilho DIN.
//
// Antes eram 36 miniaturas de 4,4 cm — bonito de ver, impossível de acertar
// com o dedo em AR: o alvo ficava menor que a imprecisão do toque. Três peças
// de 16 cm resolvem isso e ainda deixam a função de cada uma óbvia.
//
// Cada disjuntor é nó próprio (clicável sozinho) mas filho da fileira, então
// continua acompanhando-a na vista explodida. Alavanca e marcador são filhos
// do disjuntor: a alavanca desce ao desligar, o marcador troca de cor.
const railZ = 0.02;
const breakers = [];

// Três circuitos independentes, sem disjuntor geral. O geral existia para
// demonstrar hierarquia, mas com cargas espalhadas pela instalação o que o
// usuário precisa nomear é "a que disjuntor esta tomada está ligada" — e três
// nomes curtos e simétricos (D1, D2, D3) fazem isso melhor.
const LAYOUT = [
  { id: "d1", label: "D1", x: -0.19 },
  { id: "d2", label: "D2", x: 0.0 },
  { id: "d3", label: "D3", x: 0.19 },
];

const breakerY = 1.16;
const rowPart = "Fileira1";
box(rowPart, M.Ferragem, [0, breakerY - 0.15, railZ], [W - 0.16, 0.014, 0.032]);

for (const { id, label, x } of LAYOUT) {
  breakers.push({ id, label });

  const body = declare(`Disj-${id}`, { parent: rowPart, extras: { circuitId: id } });
  box(body, M.Disjuntor, [x, breakerY, railZ + 0.045], [0.16, 0.26, 0.09]);

  const lever = declare(`Alav-${id}`, { parent: body, extras: { role: "lever" } });
  box(lever, M.Alavanca, [x, breakerY + 0.05, railZ + 0.10], [0.06, 0.09, 0.026]);

  // Marcador de estado na face frontal, acima da alavanca.
  const marker = declare(`Marc-${id}`, { parent: body, extras: { role: "marker" } });
  box(marker, M.Marcador, [x, breakerY - 0.065, railZ + 0.093], [0.075, 0.05, 0.012]);
}

// barramentos de cobre
for (const x of [-0.30, -0.26, -0.22]) {
  box("Barramentos", M.Barramento, [x, 1.35, railZ - 0.02], [0.012, 0.62, 0.006]);
}

// lâmpadas de sinalização: montadas na porta (furos na chapa frontal), então
// são FILHAS de "Porta" e viajam com ela. Cada uma é nó próprio para poder
// acender/apagar sozinha conforme o circuito que a alimenta.
const lampMaterials = [M.LampadaVerde, M.LampadaVermelha, M.LampadaAmbar];
const lampIds = [];
for (let i = 0; i < 6; i += 1) {
  const id = `lamp${String(i + 1).padStart(2, "0")}`;
  lampIds.push(id);
  const p = declare(`Lampada-${id}`, { parent: "Porta", extras: { circuitId: id } });
  cylinder(p, lampMaterials[i % 3], [-0.24 + i * 0.095, 1.62, doorZ + 0.022], 0.014, 0.014, "z");
}
box("Porta", M.Placa, [0, 1.45, doorZ + 0.018], [0.34, 0.10, 0.004]);

// --- esquema elétrico embutido no próprio modelo -------------------------
// Vai em `scene.extras` e é lido por src/panel.js, que o entrega a
// CircuitModel.fromJSON. O GLB carrega geometria E esquema: trocar de modelo
// não exige mexer em nenhuma lógica, e o formato é exatamente o que
// circuits.js já serializa.
const circuitElements = [
  {
    id: "entrada",
    kind: "source",
    label: "Alimentação",
    feeds: breakers.map((b) => b.id),
  },
  ...breakers.map((b, i, all) => ({
    id: b.id,
    kind: "breaker",
    label: b.label,
    // As lâmpadas de sinalização da porta se dividem entre os disjuntores:
    // desligar um apaga só as dele. Cargas de fora da instalação são ligadas
    // em runtime, quando o usuário associa (ver src/element-scene.js).
    feeds: lampIds.filter((_, n) => n % all.length === i),
  })),
  ...lampIds.map((id, i) => ({
    id,
    kind: "lamp",
    label: `Sinalizador ${i + 1}`,
    feeds: [],
  })),
];

// prensa-cabos na base
for (let i = 0; i < 6; i += 1) {
  cylinder("PrensaCabos", M.Ferragem, [-0.25 + i * 0.10, PLINTH + 0.04, -D / 2 + 0.03], 0.016, 0.05, "z");
}

// ---------------------------------------------------------------- export GLB
const out = write("models/equipamento.glb", {
  // O esquema elétrico viaja na cena, não num nó: descreve o conjunto, e o
  // GLTFLoader entrega `scene.extras` em `gltf.scene.userData`.
  circuits: { version: 1, elements: circuitElements },
});

const explodable = out.nodes.filter((n) => n.extras?.explode).length;
const clickable = out.nodes.filter((n) => n.extras?.circuitId).length;
console.log(
  `models/equipamento.glb gerado — ${out.nodes.length} nós (${explodable} explodem, ` +
    `${clickable} ligados a circuito), ${circuitElements.length} elementos elétricos, ` +
    `${out.triangles} triângulos, ${(out.bytes / 1024) | 0} KB`
);
