import * as THREE from "three";
import { LANDMARK } from "./hand-analyzer.js";

/**
 * Provider de mão via WebXR Hand Input (XRHand / joint poses).
 *
 * Caminho preferencial quando existe: os joints vêm em espaço 3D real, já
 * sincronizados com o tracking, sem nenhum custo de visão computacional.
 *
 * Realidade de suporte: hoje isso é entregue por headsets (Android XR, Quest).
 * O ARCore em celular NÃO expõe esqueleto de mão ao WebXR, então num Galaxy
 * S20 FE este provider simplesmente não vai se habilitar — por isso a detecção
 * é feita em runtime, e não por suposição.
 */

// Joints do WebXR mapeados nos índices que o analisador espera.
const JOINT_BY_INDEX = {
  [LANDMARK.wrist]: "wrist",
  [LANDMARK.thumbMcp]: "thumb-phalanx-proximal",
  [LANDMARK.thumbTip]: "thumb-tip",
  [LANDMARK.indexMcp]: "index-finger-metacarpal",
  [LANDMARK.indexPip]: "index-finger-phalanx-proximal",
  [LANDMARK.indexTip]: "index-finger-tip",
  [LANDMARK.middleMcp]: "middle-finger-metacarpal",
  [LANDMARK.middlePip]: "middle-finger-phalanx-proximal",
  [LANDMARK.middleTip]: "middle-finger-tip",
  [LANDMARK.ringMcp]: "ring-finger-metacarpal",
  [LANDMARK.ringPip]: "ring-finger-phalanx-proximal",
  [LANDMARK.ringTip]: "ring-finger-tip",
  [LANDMARK.pinkyMcp]: "pinky-finger-metacarpal",
  [LANDMARK.pinkyPip]: "pinky-finger-phalanx-proximal",
  [LANDMARK.pinkyTip]: "pinky-finger-tip",
};

const _world = new THREE.Vector3();

export class NativeHandProvider {
  static kind = "native";

  /** Só se habilita se a feature foi concedida E existe um inputSource com mão. */
  static isAvailable(session) {
    if (!session?.enabledFeatures?.includes("hand-tracking")) return false;
    for (const source of session.inputSources) if (source.hand) return true;
    return false;
  }

  constructor({ session }) {
    this.kind = "native";
    this.session = session;
    this.points = new Array(21).fill(null);
  }

  async init() {
    return true;
  }

  /** @returns {Array<{x,y}>|null} landmarks em coordenadas de tela [0..1] */
  update({ frame, referenceSpace, camera }) {
    if (!frame || !camera) return null;

    for (const source of this.session.inputSources) {
      const hand = source.hand;
      if (!hand) continue;

      let found = 0;
      this.points.fill(null);

      for (const [index, jointName] of Object.entries(JOINT_BY_INDEX)) {
        const joint = hand.get(jointName);
        if (!joint) continue;
        const pose = frame.getJointPose(joint, referenceSpace);
        if (!pose) continue;

        // Projeta o joint 3D na tela para que o analisador receba sempre a
        // mesma estrutura, venha do WebXR ou do MediaPipe.
        _world.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        _world.project(camera);
        this.points[index] = { x: (_world.x + 1) / 2, y: (1 - _world.y) / 2 };
        found += 1;
      }

      if (found >= 4) return this.points;
    }
    return null;
  }

  dispose() {
    this.points.length = 0;
  }
}
