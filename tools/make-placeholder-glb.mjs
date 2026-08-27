/**
 * Gera um GLB de marcação (models/equipamento.glb) para a POC rodar sem o
 * modelo real. Basta substituir o arquivo pelo GLB do equipamento.
 * Uso: node tools/make-placeholder-glb.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

// Caixa com a base em y = 0 e dimensões em METROS (escala real do mundo).
const W = 0.60, H = 0.90, D = 0.40;
const x = W / 2, z = D / 2;

const faces = [
  { n: [0, 0, 1],  v: [[-x, 0, z], [x, 0, z], [x, H, z], [-x, H, z]] },
  { n: [0, 0, -1], v: [[x, 0, -z], [-x, 0, -z], [-x, H, -z], [x, H, -z]] },
  { n: [1, 0, 0],  v: [[x, 0, z], [x, 0, -z], [x, H, -z], [x, H, z]] },
  { n: [-1, 0, 0], v: [[-x, 0, -z], [-x, 0, z], [-x, H, z], [-x, H, -z]] },
  { n: [0, 1, 0],  v: [[-x, H, z], [x, H, z], [x, H, -z], [-x, H, -z]] },
  { n: [0, -1, 0], v: [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]] },
];

const positions = [], normals = [], indices = [];
faces.forEach((f, i) => {
  f.v.forEach((p) => { positions.push(...p); normals.push(...f.n); });
  const o = i * 4;
  indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
});

const posBuf = Buffer.from(new Float32Array(positions).buffer);
const nrmBuf = Buffer.from(new Float32Array(normals).buffer);
const idxBuf = Buffer.from(new Uint16Array(indices).buffer);
// glTF exige chunks alinhados em 4 bytes: JSON preenchido com espaços, BIN com zeros.
const pad = (b, fill = 0x00, a = 4) =>
  b.length % a ? Buffer.concat([b, Buffer.alloc(a - (b.length % a), fill)]) : b;

const posOff = 0;
const nrmOff = posOff + posBuf.length;
const idxOff = nrmOff + nrmBuf.length;
const bin = pad(Buffer.concat([posBuf, nrmBuf, idxBuf]));

const min = [-x, 0, -z], max = [x, H, z];

const gltf = {
  asset: { version: "2.0", generator: "placeholder-equipamento" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "Equipamento" }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{
    name: "Placeholder",
    pbrMetallicRoughness: {
      baseColorFactor: [0.62, 0.65, 0.70, 1],
      metallicFactor: 0.15,
      roughnessFactor: 0.55,
    },
  }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: indices.length, type: "SCALAR" },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: posOff, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: nrmOff, byteLength: nrmBuf.length, target: 34962 },
    { buffer: 0, byteOffset: idxOff, byteLength: idxBuf.length, target: 34963 },
  ],
  buffers: [{ byteLength: bin.length }],
};

const jsonChunk = pad(Buffer.from(JSON.stringify(gltf), "utf8"), 0x20);
const header = Buffer.alloc(12);
header.write("glTF", 0, "ascii");
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);

const chunk = (data, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};

mkdirSync("models", { recursive: true });
writeFileSync("models/equipamento.glb", Buffer.concat([
  header, chunk(jsonChunk, 0x4e4f534a), chunk(bin, 0x004e4942),
]));
console.log("models/equipamento.glb gerado");
