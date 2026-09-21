#!/usr/bin/env node
/**
 * Checks a GLB against the contract TalkingHead + HeadAudio require.
 *
 * Missing pieces fail silently at runtime — no `Armature` throws on
 * `showAvatar`, and missing visemes just leave the mouth shut — so a static
 * check is cheaper than debugging a still face.
 *
 * Usage: node scripts/check-avatar.mjs public/avatars/your-avatar.glb
 */

import { readFileSync } from "node:fs";

/** Oculus visemes. HeadAudio writes these morph targets directly, so a rig
 * without them renders a head that never speaks. */
const OCULUS_VISEMES = [
  "viseme_sil",
  "viseme_PP",
  "viseme_FF",
  "viseme_TH",
  "viseme_DD",
  "viseme_kk",
  "viseme_CH",
  "viseme_SS",
  "viseme_nn",
  "viseme_RR",
  "viseme_aa",
  "viseme_E",
  "viseme_I",
  "viseme_O",
  "viseme_U"
];

/** ARKit blend shapes. These drive expressions, blinks and moods. */
const ARKIT_BLENDSHAPES = [
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawRight",
  "jawOpen",
  "mouthClose",
  "mouthFunnel",
  "mouthPucker",
  "mouthLeft",
  "mouthRight",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "noseSneerLeft",
  "noseSneerRight",
  "tongueOut"
];

/** Derived from ARKit when absent, so they are reported but not required. */
const OPTIONAL_BLENDSHAPES = [
  "mouthOpen",
  "mouthSmile",
  "eyesClosed",
  "eyesLookUp",
  "eyesLookDown"
];

/** Bones `speakWithHands()` drives through IK. */
const GESTURE_BONES = [
  "LeftShoulder",
  "RightShoulder",
  "LeftArm",
  "RightArm",
  "LeftForeArm",
  "RightForeArm",
  "LeftHand",
  "RightHand",
  "LeftHandMiddle1",
  "RightHandMiddle1"
];

function readGlbJson(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error("Not a GLB file (missing glTF magic)");
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(
        buffer.toString("utf8", offset + 8, offset + 8 + length)
      );
    }
    offset += 8 + length;
  }
  throw new Error("GLB has no JSON chunk");
}

function morphTargetNames(gltf) {
  const names = new Set();
  for (const mesh of gltf.meshes ?? []) {
    for (const name of mesh.extras?.targetNames ?? []) names.add(name);
  }
  return names;
}

function report(label, missing, required) {
  if (missing.length === 0) {
    console.log(`  ok    ${label}`);
    return true;
  }
  if (!required) {
    console.log(`  warn  ${label}: missing ${missing.join(", ")}`);
    return true;
  }
  console.log(`  FAIL  ${label}: missing ${missing.join(", ")}`);
  return false;
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/check-avatar.mjs <avatar.glb>");
    process.exit(2);
  }

  const gltf = readGlbJson(path);
  const nodes = new Set((gltf.nodes ?? []).map((node) => node.name));
  const morphs = morphTargetNames(gltf);

  const bytes = readFileSync(path).length;
  console.log(`\n${path} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  let ok = true;

  // `modelRoot` defaults to "Armature"; without it showAvatar throws.
  ok =
    report(
      "root object `Armature`",
      nodes.has("Armature") ? [] : ["Armature"],
      true
    ) && ok;
  ok =
    report(
      "Oculus visemes (15)",
      OCULUS_VISEMES.filter((n) => !morphs.has(n)),
      true
    ) && ok;
  ok =
    report(
      "ARKit blend shapes (52)",
      ARKIT_BLENDSHAPES.filter((n) => !morphs.has(n)),
      true
    ) && ok;
  report(
    "derived blend shapes (optional)",
    OPTIONAL_BLENDSHAPES.filter((n) => !morphs.has(n)),
    false
  );
  report(
    "gesture IK bones",
    GESTURE_BONES.filter((n) => !nodes.has(n)),
    false
  );

  console.log(`  info  ${morphs.size} morph targets, ${nodes.size} nodes`);
  if (bytes > 5 * 1024 * 1024) {
    console.log("  warn  over 5 MB — compress before shipping:");
    console.log(
      "        npx gltf-transform optimize in.glb out.glb --compress meshopt"
    );
  }

  console.log(ok ? "\nCompatible.\n" : "\nNot compatible with TalkingHead.\n");
  process.exit(ok ? 0 : 1);
}

main();
