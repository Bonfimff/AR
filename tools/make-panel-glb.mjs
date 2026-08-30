/**
 * Gera models/equipamento.glb: um QUADRO ELÉTRICO industrial de piso.
 *
 * Modelo próprio, criado por geração procedural — sem dependência de asset de
 * terceiros e, portanto, sem qualquer dúvida de licença para uso no projeto.
 *
 * Dimensões reais: 0,80 m (L) x 2,00 m (A) x 0,40 m (P), incluindo o rodapé.
 *
 * ESTRUTURA EM PEÇAS (não só em materiais): cada componente lógico — porta,
 * cada fileira de disjuntores, barramentos, grelhas... — vira seu próprio nó
 * glTF, com a direção/distância da "vista explodida" gravada em
 * `node.extras.explode`. O GLTFLoader do Three.js copia `extras` para
 * `object3D.userData` automaticamente, então src/explode.js só precisa ler
 * `userData.explode` — nenhuma lista de nomes hardcoded fora do modelo.
 * Peças sem `explode` (Rodape, Vao) são o "esqueleto": ficam paradas,
 * servindo de referência enquanto o resto se afasta.
 *
 * Uso: node tools/make-panel-glb.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

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
];
const M = Object.fromEntries(MATERIALS.map((m, i) => [m.name, i]));

// --- peças: nome -> deslocamento (m) na vista explodida. Ausente = parado. ---
const EXPLODE = {
  Fundo: [0, 0, -0.35],
  LateralEsq: [-0.35, 0, 0],
  LateralDir: [0.35, 0, 0],
  Topo: [0, 0.35, 0],
  // Rodape e Vao ficam de fora do mapa: são o esqueleto, não se movem.
  Porta: [0, 0, 0.55],
  Fileira1: [0, -0.15, 0.45],
  Fileira2: [0, 0, 0.55],
  Fileira3: [0, 0.15, 0.65],
  Barramentos: [-0.25, 0, 0.25],
  GrelhaSuperior: [0, 0.15, 0.40],
  GrelhaInferior: [0, -0.15, 0.40],
  Indicadores: [0, 0, 0.35],
  PrensaCabos: [0, -0.20, -0.30],
};

// --- acumuladores por (peça, material) ---
const groups = new Map(); // key `${part}|${mat}` -> {part, mat, positions, normals, indices}
function group(part, mat) {
  const key = `${part}|${mat}`;
  let g = groups.get(key);
  if (!g) {
    g = { part, mat, positions: [], normals: [], indices: [] };
    groups.set(key, g);
  }
  return g;
}

function addQuad(g, a, b, c, d, n) {
  const base = g.positions.length / 3;
  for (const v of [a, b, c, d]) {
    g.positions.push(v[0], v[1], v[2]);
    g.normals.push(n[0], n[1], n[2]);
  }
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Caixa por centro e tamanho. */
function box(part, mat, [cx, cy, cz], [sx, sy, sz]) {
  const g = group(part, mat);
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  addQuad(g, [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], [0,0,1]);
  addQuad(g, [x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0], [0,0,-1]);
  addQuad(g, [x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1], [1,0,0]);
  addQuad(g, [x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0], [-1,0,0]);
  addQuad(g, [x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0], [0,1,0]);
  addQuad(g, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [0,-1,0]);
}

/** Cilindro ao longo de um eixo ('x' | 'y' | 'z'). */
function cylinder(part, mat, [cx, cy, cz], radius, length, axis = "z", segments = 12) {
  const g = group(part, mat);
  const half = length / 2;
  const ring = (t) => {
    const a = (t / segments) * Math.PI * 2;
    const u = Math.cos(a) * radius;
    const v = Math.sin(a) * radius;
    return axis === "z" ? [u, v, 0] : axis === "y" ? [u, 0, v] : [0, u, v];
  };
  const along = axis === "z" ? [0, 0, 1] : axis === "y" ? [0, 1, 0] : [1, 0, 0];
  const shift = (p, s) => [cx + p[0] + along[0]*s, cy + p[1] + along[1]*s, cz + p[2] + along[2]*s];

  for (let t = 0; t < segments; t += 1) {
    const p = ring(t), q = ring(t + 1);
    const n = [p[0] || 0, p[1] || 0, p[2] || 0];
    const len = Math.hypot(...n) || 1;
    addQuad(g, shift(p,-half), shift(q,-half), shift(q,half), shift(p,half),
      [n[0]/len, n[1]/len, n[2]/len]);
  }
  // tampas
  for (const side of [-1, 1]) {
    const base = g.positions.length / 3;
    const center = shift([0,0,0], half*side);
    g.positions.push(...center);
    g.normals.push(along[0]*side, along[1]*side, along[2]*side);
    for (let t = 0; t <= segments; t += 1) {
      const p = shift(ring(t), half*side);
      g.positions.push(...p);
      g.normals.push(along[0]*side, along[1]*side, along[2]*side);
    }
    for (let t = 0; t < segments; t += 1) {
      if (side > 0) g.indices.push(base, base+1+t, base+2+t);
      else g.indices.push(base, base+2+t, base+1+t);
    }
  }
}

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
box("Vao", M.Vao, [0, bodyY, 0], [W - 0.08, bodyH - 0.04, D - 0.08]); // interior escuro (esqueleto)

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

// grelhas de ventilação (duas peças, cada uma com suas lâminas)
for (const [part, baseY] of [["GrelhaSuperior", 1.72], ["GrelhaInferior", 0.30]]) {
  for (let i = 0; i < 10; i += 1) {
    box(part, M.Vao, [-0.18, baseY + i * 0.014, doorZ + 0.016], [0.26, 0.006, 0.004]);
    box(part, M.Vao, [0.18, baseY + i * 0.014, doorZ + 0.016], [0.26, 0.006, 0.004]);
  }
}

// interior: trilhos DIN com disjuntores — uma peça por fileira
const railZ = 0.02;
for (let row = 0; row < 3; row += 1) {
  const part = `Fileira${row + 1}`;
  const y = 0.72 + row * 0.30;
  box(part, M.Ferragem, [0, y - 0.035, railZ], [W - 0.16, 0.012, 0.03]);
  for (let i = 0; i < 12; i += 1) {
    const x = -0.28 + i * 0.051;
    box(part, M.Disjuntor, [x, y, railZ + 0.025], [0.044, 0.075, 0.05]);
    box(part, M.Alavanca, [x, y + 0.016, railZ + 0.055], [0.018, 0.026, 0.014]);
  }
}

// barramentos de cobre
for (const x of [-0.30, -0.26, -0.22]) {
  box("Barramentos", M.Barramento, [x, 1.35, railZ - 0.02], [0.012, 0.62, 0.006]);
}

// lâmpadas de sinalização e placa de identificação
const lamps = [M.LampadaVerde, M.LampadaVermelha, M.LampadaAmbar];
for (let i = 0; i < 6; i += 1) {
  cylinder("Indicadores", lamps[i % 3], [-0.24 + i * 0.095, 1.62, doorZ + 0.022], 0.014, 0.014, "z");
}
box("Indicadores", M.Placa, [0, 1.45, doorZ + 0.018], [0.34, 0.10, 0.004]);

// prensa-cabos na base
for (let i = 0; i < 6; i += 1) {
  cylinder("PrensaCabos", M.Ferragem, [-0.25 + i * 0.10, PLINTH + 0.04, -D / 2 + 0.03], 0.016, 0.05, "z");
}

// ---------------------------------------------------------------- export GLB
const chunks = [];
const accessors = [];
const bufferViews = [];
let offset = 0;

const push = (buf, target) => {
  const start = offset;
  chunks.push(buf);
  offset += buf.length;
  bufferViews.push({ buffer: 0, byteOffset: start, byteLength: buf.length, target });
  return bufferViews.length - 1;
};

// Agrupa os acumuladores (peça, material) em primitivas por PEÇA — é isso que
// transforma cada componente lógico num nó/mesh independente no glTF.
const byPart = new Map();
for (const g of groups.values()) {
  if (!g.indices.length) continue;
  if (!byPart.has(g.part)) byPart.set(g.part, []);
  byPart.get(g.part).push(g);
}

const meshes = [];
const nodes = [];
for (const [part, partGroups] of byPart) {
  const primitives = [];
  for (const g of partGroups) {
    const pos = Buffer.from(new Float32Array(g.positions).buffer);
    const nrm = Buffer.from(new Float32Array(g.normals).buffer);
    const idx = Buffer.from(new Uint32Array(g.indices).buffer);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], g.positions[i + k]);
        max[k] = Math.max(max[k], g.positions[i + k]);
      }
    }

    const posView = push(pos, 34962);
    const nrmView = push(nrm, 34962);
    const idxView = push(idx, 34963);

    accessors.push({ bufferView: posView, componentType: 5126, count: g.positions.length / 3, type: "VEC3", min, max });
    accessors.push({ bufferView: nrmView, componentType: 5126, count: g.normals.length / 3, type: "VEC3" });
    accessors.push({ bufferView: idxView, componentType: 5125, count: g.indices.length, type: "SCALAR" });

    primitives.push({
      attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 },
      indices: accessors.length - 1,
      material: g.mat,
    });
  }

  meshes.push({ name: part, primitives });
  const node = { mesh: meshes.length - 1, name: part };
  if (EXPLODE[part]) node.extras = { explode: EXPLODE[part] };
  nodes.push(node);
}

const bin = Buffer.concat(chunks);
const binPadded = bin.length % 4 ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]) : bin;

const gltf = {
  asset: { version: "2.0", generator: "quadro-eletrico-procedural" },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  meshes,
  materials: MATERIALS.map((m) => ({
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: m.color,
      metallicFactor: m.metallic,
      roughnessFactor: m.roughness,
    },
    ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
  })),
  accessors,
  bufferViews,
  buffers: [{ byteLength: binPadded.length }],
};

const jsonRaw = Buffer.from(JSON.stringify(gltf), "utf8");
const jsonChunk = jsonRaw.length % 4
  ? Buffer.concat([jsonRaw, Buffer.alloc(4 - (jsonRaw.length % 4), 0x20)])
  : jsonRaw;

const header = Buffer.alloc(12);
header.write("glTF", 0, "ascii");
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binPadded.length, 8);

const chunk = (data, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};

mkdirSync("models", { recursive: true });
writeFileSync(
  "models/equipamento.glb",
  Buffer.concat([header, chunk(jsonChunk, 0x4e4f534a), chunk(binPadded, 0x004e4942)])
);

const tris = [...groups.values()].reduce((sum, g) => sum + g.indices.length / 3, 0);
const explodable = nodes.filter((n) => n.extras).length;
console.log(
  `models/equipamento.glb gerado — ${nodes.length} peças (${explodable} explodem, ` +
    `${nodes.length - explodable} fixas), ${tris} triângulos, ` +
    `${(12 + 8 + jsonChunk.length + 8 + binPadded.length) / 1024 | 0} KB`
);
