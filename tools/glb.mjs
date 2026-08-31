/**
 * Construtor de glTF 2.0 binário (GLB) em Node puro, sem dependências.
 *
 * Extraído de make-panel-glb.mjs quando surgiu o segundo gerador: a geometria
 * muda de um elemento para outro, mas o empacotamento (acumular por peça,
 * montar accessors/bufferViews, hierarquia de nós, cabeçalho GLB) é idêntico
 * e não deve ser copiado.
 *
 * Modelo mental: a geometria se acumula em PEÇAS nomeadas, não em materiais.
 * Cada peça vira um nó glTF próprio, e é isso que permite ao app tratar cada
 * componente lógico como uma entidade — mover na vista explodida, receber
 * toque, mudar de cor. Peças podem ser filhas de outras peças.
 *
 * `extras` de cada peça reaparece em `object3D.userData` no GLTFLoader, e o
 * `extras` da cena reaparece em `gltf.scene.userData`: é o canal por onde o
 * modelo carrega o próprio comportamento, sem lista de nomes no código do app.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createBuilder({ materials, generator = "modo-ar-procedural" }) {
  const materialIndex = Object.fromEntries(materials.map((m, i) => [m.name, i]));

  const groups = new Map(); // `${part}|${mat}` -> acumulador
  const partMeta = new Map(); // part -> {parent, extras}

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

  /** Declara hierarquia e comportamento de uma peça. Acumulativo. */
  function declare(name, meta = {}) {
    const previous = partMeta.get(name) ?? {};
    partMeta.set(name, {
      ...previous,
      ...meta,
      extras: { ...(previous.extras ?? {}), ...(meta.extras ?? {}) },
    });
    return name;
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

  /**
   * @param {string} path arquivo .glb de saída
   * @param {object} [sceneExtras] vai para `gltf.scene.userData` (ex.: circuitos)
   */
  function write(path, sceneExtras) {
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

    const byPart = new Map();
    for (const g of groups.values()) {
      if (!g.indices.length) continue;
      if (!byPart.has(g.part)) byPart.set(g.part, []);
      byPart.get(g.part).push(g);
    }

    // Toda peça vira nó, mesmo uma que só exista para agrupar filhas.
    const partNames = new Set([...byPart.keys(), ...partMeta.keys()]);
    const meshes = [];
    const nodes = [];
    const nodeIndex = new Map();

    for (const part of partNames) {
      const primitives = [];
      for (const g of byPart.get(part) ?? []) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < g.positions.length; i += 3) {
          for (let k = 0; k < 3; k += 1) {
            min[k] = Math.min(min[k], g.positions[i + k]);
            max[k] = Math.max(max[k], g.positions[i + k]);
          }
        }
        const posView = push(Buffer.from(new Float32Array(g.positions).buffer), 34962);
        const nrmView = push(Buffer.from(new Float32Array(g.normals).buffer), 34962);
        const idxView = push(Buffer.from(new Uint32Array(g.indices).buffer), 34963);

        accessors.push({ bufferView: posView, componentType: 5126, count: g.positions.length / 3, type: "VEC3", min, max });
        accessors.push({ bufferView: nrmView, componentType: 5126, count: g.normals.length / 3, type: "VEC3" });
        accessors.push({ bufferView: idxView, componentType: 5125, count: g.indices.length, type: "SCALAR" });

        primitives.push({
          attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 },
          indices: accessors.length - 1,
          material: g.mat,
        });
      }

      const node = { name: part };
      if (primitives.length) {
        meshes.push({ name: part, primitives });
        node.mesh = meshes.length - 1;
      }
      const extras = partMeta.get(part)?.extras ?? {};
      if (Object.keys(extras).length) node.extras = extras;

      nodeIndex.set(part, nodes.length);
      nodes.push(node);
    }

    // Hierarquia só depois de TODOS os nós existirem, senão a ordem de
    // declaração das peças passaria a importar.
    const rootNodes = [];
    for (const part of partNames) {
      const parent = partMeta.get(part)?.parent;
      if (parent == null) {
        rootNodes.push(nodeIndex.get(part));
        continue;
      }
      if (!nodeIndex.has(parent)) throw new Error(`Peça "${part}": pai "${parent}" não existe`);
      (nodes[nodeIndex.get(parent)].children ??= []).push(nodeIndex.get(part));
    }

    const bin = Buffer.concat(chunks);
    const binPadded = bin.length % 4
      ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))])
      : bin;

    const scene = { nodes: rootNodes };
    if (sceneExtras) scene.extras = sceneExtras;

    const gltf = {
      asset: { version: "2.0", generator },
      scene: 0,
      scenes: [scene],
      nodes,
      meshes,
      materials: materials.map((m) => ({
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

    const total = 12 + 8 + jsonChunk.length + 8 + binPadded.length;
    const header = Buffer.alloc(12);
    header.write("glTF", 0, "ascii");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);

    const chunk = (data, type) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(data.length, 0);
      h.writeUInt32LE(type, 4);
      return Buffer.concat([h, data]);
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.concat([
      header,
      chunk(jsonChunk, 0x4e4f534a),
      chunk(binPadded, 0x004e4942),
    ]));

    const triangles = [...groups.values()].reduce((sum, g) => sum + g.indices.length / 3, 0);
    return { nodes, meshes, triangles, bytes: total };
  }

  return { M: materialIndex, box, cylinder, declare, write };
}
