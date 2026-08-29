import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(APP_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DATA_FILE = path.resolve(
  process.env.RC_CAR_STATE_FILE || path.join(APP_DIR, "data", "assembly.json"),
);
const BUILD_DIR = path.resolve(
  process.env.RC_CAR_BUILD_DIR || path.join(PROJECT_DIR, "build", "web"),
);
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HISTORY_ENTRIES = Math.max(1, Number(process.env.RC_CAR_HISTORY_DEPTH || 500));

const FASTENER_STANDARDS = Object.freeze({
  ISO4762: {
    name: "Hex socket head cap screw",
    dimensions: {
      2: { headDiameterMm: 3.8, headHeightMm: 2, socketAcrossFlatsMm: 1.5, socketDepthMm: 1 },
      2.5: { headDiameterMm: 4.5, headHeightMm: 2.5, socketAcrossFlatsMm: 2, socketDepthMm: 1.1 },
      3: { headDiameterMm: 5.5, headHeightMm: 3, socketAcrossFlatsMm: 2.5, socketDepthMm: 1.3 },
      4: { headDiameterMm: 7, headHeightMm: 4, socketAcrossFlatsMm: 3, socketDepthMm: 2 },
      5: { headDiameterMm: 8.5, headHeightMm: 5, socketAcrossFlatsMm: 4, socketDepthMm: 2.5 },
      6: { headDiameterMm: 10, headHeightMm: 6, socketAcrossFlatsMm: 5, socketDepthMm: 3 },
      8: { headDiameterMm: 13, headHeightMm: 8, socketAcrossFlatsMm: 6, socketDepthMm: 4 },
    },
  },
  ISO10642: {
    name: "Hex socket countersunk head screw",
    dimensions: {
      2: { headDiameterMm: 4, headHeightMm: 1.2, socketAcrossFlatsMm: 1.3, socketDepthMm: .65 },
      2.5: { headDiameterMm: 5, headHeightMm: 1.5, socketAcrossFlatsMm: 1.5, socketDepthMm: .8 },
      3: { headDiameterMm: 6, headHeightMm: 1.7, socketAcrossFlatsMm: 2, socketDepthMm: .95 },
      4: { headDiameterMm: 8, headHeightMm: 2.3, socketAcrossFlatsMm: 2.5, socketDepthMm: 1.45 },
      5: { headDiameterMm: 10, headHeightMm: 2.8, socketAcrossFlatsMm: 3, socketDepthMm: 1.75 },
      6: { headDiameterMm: 12, headHeightMm: 3.3, socketAcrossFlatsMm: 4, socketDepthMm: 2.1 },
      8: { headDiameterMm: 16, headHeightMm: 4.4, socketAcrossFlatsMm: 5, socketDepthMm: 2.8 },
    },
  },
  ISO7380: {
    name: "Hex socket button head screw (ISO 7380-1)",
    dimensions: {
      2: { headDiameterMm: 3.5, headHeightMm: 1.3, socketAcrossFlatsMm: 1.3, socketDepthMm: .8 },
      2.5: { headDiameterMm: 4.7, headHeightMm: 1.5, socketAcrossFlatsMm: 1.5, socketDepthMm: .9 },
      3: { headDiameterMm: 5.7, headHeightMm: 1.65, socketAcrossFlatsMm: 2, socketDepthMm: 1.04 },
      4: { headDiameterMm: 7.6, headHeightMm: 2.2, socketAcrossFlatsMm: 2.5, socketDepthMm: 1.3 },
      5: { headDiameterMm: 9.5, headHeightMm: 2.75, socketAcrossFlatsMm: 3, socketDepthMm: 1.56 },
      6: { headDiameterMm: 10.5, headHeightMm: 3.3, socketAcrossFlatsMm: 4, socketDepthMm: 1.9 },
      8: { headDiameterMm: 14, headHeightMm: 4.4, socketAcrossFlatsMm: 5, socketDepthMm: 2.6 },
    },
  },
  ISO4017: {
    name: "Hexagon head bolt (ISO 4017)",
    dimensions: {
      2: { headDiameterMm: 4.62, headHeightMm: 1.4, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
      2.5: { headDiameterMm: 5.77, headHeightMm: 1.7, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
      3: { headDiameterMm: 6.35, headHeightMm: 2, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
      4: { headDiameterMm: 8.08, headHeightMm: 2.8, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
      5: { headDiameterMm: 9.24, headHeightMm: 3.5, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
      6: { headDiameterMm: 11.55, headHeightMm: 4, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
      8: { headDiameterMm: 15.01, headHeightMm: 5.3, socketAcrossFlatsMm: 0, socketDepthMm: 0 },
    },
  },
});

const BEARING_CATALOG = Object.freeze({
  MR63: { innerDiameterMm: 3, outerDiameterMm: 6, widthMm: 2 },
  MR74: { innerDiameterMm: 4, outerDiameterMm: 7, widthMm: 2 },
  MR84: { innerDiameterMm: 4, outerDiameterMm: 8, widthMm: 3 },
  MR85: { innerDiameterMm: 5, outerDiameterMm: 8, widthMm: 2.5 },
  MR95: { innerDiameterMm: 5, outerDiameterMm: 9, widthMm: 3 },
  MR104: { innerDiameterMm: 4, outerDiameterMm: 10, widthMm: 4 },
  MR105: { innerDiameterMm: 5, outerDiameterMm: 10, widthMm: 4 },
  MR106: { innerDiameterMm: 6, outerDiameterMm: 10, widthMm: 3 },
  MR115: { innerDiameterMm: 5, outerDiameterMm: 11, widthMm: 4 },
  MR117: { innerDiameterMm: 7, outerDiameterMm: 11, widthMm: 3 },
  MR126: { innerDiameterMm: 6, outerDiameterMm: 12, widthMm: 4 },
  MR128: { innerDiameterMm: 8, outerDiameterMm: 12, widthMm: 3.5 },
  MR137: { innerDiameterMm: 7, outerDiameterMm: 13, widthMm: 4 },
  MR148: { innerDiameterMm: 8, outerDiameterMm: 14, widthMm: 4 },
  605: { innerDiameterMm: 5, outerDiameterMm: 14, widthMm: 5 },
  606: { innerDiameterMm: 6, outerDiameterMm: 17, widthMm: 6 },
  607: { innerDiameterMm: 7, outerDiameterMm: 19, widthMm: 6 },
  608: { innerDiameterMm: 8, outerDiameterMm: 22, widthMm: 7 },
  6000: { innerDiameterMm: 10, outerDiameterMm: 26, widthMm: 8 },
  6001: { innerDiameterMm: 12, outerDiameterMm: 28, widthMm: 8 },
  6002: { innerDiameterMm: 15, outerDiameterMm: 32, widthMm: 9 },
  6003: { innerDiameterMm: 17, outerDiameterMm: 35, widthMm: 10 },
  6004: { innerDiameterMm: 20, outerDiameterMm: 42, widthMm: 12 },
  6200: { innerDiameterMm: 10, outerDiameterMm: 30, widthMm: 9 },
  6201: { innerDiameterMm: 12, outerDiameterMm: 32, widthMm: 10 },
  6202: { innerDiameterMm: 15, outerDiameterMm: 35, widthMm: 11 },
  6203: { innerDiameterMm: 17, outerDiameterMm: 40, widthMm: 12 },
  6204: { innerDiameterMm: 20, outerDiameterMm: 47, widthMm: 14 },
  623: { innerDiameterMm: 3, outerDiameterMm: 10, widthMm: 4 },
  624: { innerDiameterMm: 4, outerDiameterMm: 13, widthMm: 5 },
  625: { innerDiameterMm: 5, outerDiameterMm: 16, widthMm: 5 },
  626: { innerDiameterMm: 6, outerDiameterMm: 19, widthMm: 6 },
  627: { innerDiameterMm: 7, outerDiameterMm: 22, widthMm: 7 },
  628: { innerDiameterMm: 8, outerDiameterMm: 24, widthMm: 8 },
  629: { innerDiameterMm: 9, outerDiameterMm: 26, widthMm: 8 },
  6800: { innerDiameterMm: 10, outerDiameterMm: 19, widthMm: 5 },
  6801: { innerDiameterMm: 12, outerDiameterMm: 21, widthMm: 5 },
  6802: { innerDiameterMm: 15, outerDiameterMm: 24, widthMm: 5 },
  6803: { innerDiameterMm: 17, outerDiameterMm: 26, widthMm: 5 },
  6804: { innerDiameterMm: 20, outerDiameterMm: 32, widthMm: 7 },
  685: { innerDiameterMm: 5, outerDiameterMm: 11, widthMm: 3 },
  686: { innerDiameterMm: 6, outerDiameterMm: 13, widthMm: 5 },
  687: { innerDiameterMm: 7, outerDiameterMm: 14, widthMm: 5 },
  688: { innerDiameterMm: 8, outerDiameterMm: 16, widthMm: 5 },
  689: { innerDiameterMm: 9, outerDiameterMm: 17, widthMm: 5 },
  6900: { innerDiameterMm: 10, outerDiameterMm: 22, widthMm: 6 },
  6901: { innerDiameterMm: 12, outerDiameterMm: 24, widthMm: 6 },
  6902: { innerDiameterMm: 15, outerDiameterMm: 28, widthMm: 7 },
  6903: { innerDiameterMm: 17, outerDiameterMm: 30, widthMm: 7 },
});

const RC_COMPONENT_CATALOG = Object.freeze([
  { id: "motor-3650", category: "motors", scale: "1/10", label: "3650 brushless motor", description: "Ø36 × 50 mm sensorless/sensored motor envelope", shape: { type: "motor", diameterMm: 36, bodyLengthMm: 50, shaftDiameterMm: 3.175, shaftLengthMm: 15 } },
  { id: "motor-3660", category: "motors", scale: "1/10", label: "3660 brushless motor", description: "Ø36 × 60 mm long-can motor envelope", shape: { type: "motor", diameterMm: 36, bodyLengthMm: 60, shaftDiameterMm: 5, shaftLengthMm: 17 } },
  { id: "motor-4268", category: "motors", scale: "1/8", label: "4268 brushless motor", description: "Ø42 × 68 mm 1/8 on-road motor envelope", shape: { type: "motor", diameterMm: 42, bodyLengthMm: 68, shaftDiameterMm: 5, shaftLengthMm: 18 } },
  { id: "motor-4274", category: "motors", scale: "1/8", label: "4274 brushless motor", description: "Ø42 × 74 mm 1/8 on-road motor envelope", shape: { type: "motor", diameterMm: 42, bodyLengthMm: 74, shaftDiameterMm: 5, shaftLengthMm: 18 } },
  { id: "esc-1-10-compact", category: "electronics", scale: "1/10", label: "1/10 compact ESC", description: "Compact on-road speed controller envelope", shape: { type: "esc", widthMm: 36, depthMm: 30, heightMm: 19, fanDiameterMm: 24 } },
  { id: "esc-1-8", category: "electronics", scale: "1/8", label: "1/8 ESC", description: "1/8 brushless speed controller envelope", shape: { type: "esc", widthMm: 58, depthMm: 48, heightMm: 36, fanDiameterMm: 30 } },
  { id: "servo-low-profile", category: "steering", scale: "1/10", label: "Low-profile servo", description: "40.9 × 20.1 × 25.9 mm body with four-hole mounting flange", shape: { type: "servo", widthMm: 40.9, depthMm: 20.1, heightMm: 25.9, splineDiameterMm: 6, splineHeightMm: 4, mountWidthMm: 54.5, mountDepthMm: 20.1, mountHoleSpacingXmm: 48, mountHoleSpacingYmm: 10, mountHoleDiameterMm: 3.2, mountTabThicknessMm: 2.5, mountTabCenterZMm: 8 } },
  { id: "servo-standard", category: "steering", scale: "1/8 · 1/10", label: "Standard-profile servo", description: "40 × 20 × 38 mm body with four-hole mounting flange", shape: { type: "servo", widthMm: 40, depthMm: 20, heightMm: 38, splineDiameterMm: 6, splineHeightMm: 4, mountWidthMm: 54, mountDepthMm: 20, mountHoleSpacingXmm: 48, mountHoleSpacingYmm: 10, mountHoleDiameterMm: 3.2, mountTabThicknessMm: 2.5, mountTabCenterZMm: 10 } },
  { id: "receiver-compact", category: "electronics", scale: "1/10", label: "Compact receiver", description: "Generic waterproof receiver envelope", shape: { type: "box", widthMm: 35, depthMm: 25, heightMm: 14 } },
  { id: "battery-shorty-2s", category: "power", scale: "1/10", label: "2S shorty LiPo", description: "Shorty hardcase LiPo envelope", shape: { type: "box", widthMm: 96, depthMm: 47, heightMm: 25 } },
  { id: "battery-4s-1-8", category: "power", scale: "1/8", label: "4S hardcase LiPo", description: "1/8 hardcase LiPo envelope", shape: { type: "box", widthMm: 139, depthMm: 47, heightMm: 48 } },
]);

const isGeneratedComponent = (component) => ["fastener", "bearing", "instance", "catalog", "turnbuckle", "driveshaft"].includes(component.kind);

let mutationQueue = Promise.resolve();

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteVector(value, length, field) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new HttpError(400, `${field} must contain ${length} finite numbers`);
  }
  return value.map(Number);
}

function normalizedQuaternion(value) {
  const q = finiteVector(value, 4, "quaternionXyzw");
  const norm = Math.hypot(...q);
  if (norm < 1e-9) throw new HttpError(400, "Quaternion cannot be zero");
  return q.map((item) => item / norm);
}

function multiplyQuaternion(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return normalizedQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

function inverseQuaternion(value) {
  const [x, y, z, w] = normalizedQuaternion(value);
  return [-x, -y, -z, w];
}

function relationComponentId(value) {
  const ref = Array.isArray(value) ? value[0] : value;
  return ref?.componentId || null;
}

function rigidComponentIds(state, startId) {
  const found = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    for (const joint of state.joints || []) {
      if (joint.type !== "rigid") continue;
      const first = relationComponentId(joint.source);
      const second = relationComponentId(joint.target);
      if (first !== current && second !== current) continue;
      const linked = first === current ? second : first;
      if (linked && !found.has(linked)) { found.add(linked); queue.push(linked); }
    }
  }
  return found;
}

function propagateRigidTransform(state, movedId, before, after) {
  const linkedIds = rigidComponentIds(state, movedId);
  if (linkedIds.size < 2) return;
  const deltaRotation = multiplyQuaternion(after.quaternionXyzw, inverseQuaternion(before.quaternionXyzw));
  for (const linkedId of linkedIds) {
    if (linkedId === movedId) continue;
    const linked = componentById(state, linkedId);
    if (linked.locked) throw new HttpError(409, `${linked.label} is locked as a reference`);
    const relative = linked.transform.positionMm.map((value, index) => value - before.positionMm[index]);
    const rotated = rotateVector(relative, deltaRotation);
    linked.transform.positionMm = rotated.map((value, index) => value + after.positionMm[index]);
    linked.transform.quaternionXyzw = multiplyQuaternion(
      deltaRotation,
      linked.transform.quaternionXyzw,
    );
  }
}

function normalizeVector(value) {
  const vector = finiteVector(value, 3, "vector");
  const norm = Math.hypot(...vector);
  if (norm < 1e-9) throw new HttpError(400, "Axis vector cannot be zero");
  return vector.map((item) => item / norm);
}

function rotateVector(vector, quaternion) {
  const [x, y, z, w] = normalizedQuaternion(quaternion);
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function quaternionBetweenVectors(fromValue, toValue) {
  const from = normalizeVector(fromValue);
  const to = normalizeVector(toValue);
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot < -0.999999) {
    const orthogonal = Math.abs(from[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    const axis = normalizeVector([
      from[1] * orthogonal[2] - from[2] * orthogonal[1],
      from[2] * orthogonal[0] - from[0] * orthogonal[2],
      from[0] * orthogonal[1] - from[1] * orthogonal[0],
    ]);
    return [axis[0], axis[1], axis[2], 0];
  }
  return normalizedQuaternion([
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
    1 + dot,
  ]);
}

function axisQuaternion(axis, degrees) {
  if (!["x", "y", "z"].includes(axis)) throw new HttpError(400, "Invalid axis");
  if (!Number.isFinite(degrees)) throw new HttpError(400, "Invalid rotation");
  const half = (degrees * Math.PI) / 360;
  const sine = Math.sin(half);
  return normalizedQuaternion([
    axis === "x" ? sine : 0,
    axis === "y" ? sine : 0,
    axis === "z" ? sine : 0,
    Math.cos(half),
  ]);
}

function vectorAxisQuaternion(axisValue, degrees) {
  if (!Number.isFinite(degrees)) throw new HttpError(400, "Invalid rotation");
  const axis = normalizeVector(axisValue);
  const half = (degrees * Math.PI) / 360;
  const sine = Math.sin(half);
  return normalizedQuaternion([axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)]);
}

function componentById(state, id) {
  const component = state.components.find((item) => item.id === id);
  if (!component) throw new HttpError(404, `Unknown component: ${id}`);
  return component;
}

function holeById(component, id) {
  const hole = component.interfaces?.holes?.find((item) => item.id === id);
  if (!hole) throw new HttpError(404, `Unknown hole: ${component.id}/${id}`);
  return hole;
}

function transformedPoint(component, localPoint) {
  const rotated = rotateVector(localPoint, component.transform.quaternionXyzw);
  return rotated.map((value, index) => value + component.transform.positionMm[index]);
}

function ensureFastenersGroup(state) {
  const existing = state.groups.find((group) => group.name.toLowerCase() === "fasteners");
  if (existing) return existing.id;
  let id = "fasteners";
  if (state.groups.some((group) => group.id === id)) id = `fasteners_${crypto.randomUUID()}`;
  state.groups.push({ id, name: "Fasteners" });
  return id;
}

function ensureBearingsGroup(state) {
  const existing = state.groups.find((group) => group.name.toLowerCase() === "bearings");
  if (existing) return existing.id;
  let id = "bearings";
  if (state.groups.some((group) => group.id === id)) id = `bearings_${crypto.randomUUID()}`;
  state.groups.push({ id, name: "Bearings" });
  return id;
}

function createFastenerComponent(state, operation) {
  const standard = String(operation.standard || "ISO4762").toUpperCase();
  const definition = FASTENER_STANDARDS[standard];
  if (!definition) throw new HttpError(400, `Unsupported fastener standard: ${standard}`);
  const diameterMm = Number(operation.diameterMm);
  const dimensions = definition.dimensions[diameterMm];
  if (!dimensions) throw new HttpError(400, "Fastener diameter must be M2, M2.5, M3, M4, M5, M6 or M8");
  const lengthMm = Number(operation.lengthMm);
  if (!Number.isFinite(lengthMm) || lengthMm < 4 || lengthMm > 80) {
    throw new HttpError(400, "Fastener length must be between 4 and 80 mm");
  }
  if (standard === "ISO10642" && lengthMm <= dimensions.headHeightMm) {
    throw new HttpError(400, "Countersunk screw length is too short for its head");
  }
  const target = snapInterface(state, operation.target);
  if (target.type !== "hole") throw new HttpError(400, "Fasteners can only be inserted into hole magnets");
  const openingSide = [-1, 1].includes(Number(target.ref.openingSide))
    ? Number(target.ref.openingSide) : 1;
  const directionSign = operation.flip ? -openingSide : openingSide;
  const outward = transformedAxis(target.component, target.item.localAxis)
    .map((value) => value * directionSign);
  const openingLocal = target.item.localCenterMm.map(
    (value, index) => value + target.item.localAxis[index] * target.item.depthMm * 0.5 * directionSign,
  );
  const openingWorld = transformedPoint(target.component, openingLocal);
  const extentMinZ = standard === "ISO10642" ? -lengthMm : -lengthMm;
  const extentMaxZ = standard === "ISO10642" ? 0 : dimensions.headHeightMm;
  const localCenterZ = (extentMinZ + extentMaxZ) * 0.5;
  const positionMm = openingWorld.map((value, index) => value + outward[index] * localCenterZ);
  const quaternionXyzw = quaternionBetweenVectors([0, 0, 1], outward);
  const id = `fastener_${crypto.randomUUID().replaceAll("-", "_")}`;
  const groupId = ensureFastenersGroup(state);
  const component = {
    id,
    label: `${standard} M${diameterMm}×${lengthMm}`,
    status: "generated-fastener",
    kind: "fastener",
    meshUrl: null,
    triangles: 192,
    sizeMm: [dimensions.headDiameterMm, dimensions.headDiameterMm, extentMaxZ - extentMinZ],
    baseBoundsMm: {
      min: positionMm.map((value, index) => value - [dimensions.headDiameterMm / 2, dimensions.headDiameterMm / 2, (extentMaxZ - extentMinZ) / 2][index]),
      max: positionMm.map((value, index) => value + [dimensions.headDiameterMm / 2, dimensions.headDiameterMm / 2, (extentMaxZ - extentMinZ) / 2][index]),
      center: jsonClone(positionMm),
    },
    transform: { positionMm, quaternionXyzw },
    baseTransform: { positionMm: jsonClone(positionMm), quaternionXyzw: jsonClone(quaternionXyzw) },
    visible: true,
    locked: false,
    color: "#aeb4ba",
    groupId,
    fastener: {
      standard,
      description: definition.name,
      diameterMm,
      lengthMm,
      headDiameterMm: dimensions.headDiameterMm,
      headHeightMm: dimensions.headHeightMm,
      socketAcrossFlatsMm: dimensions.socketAcrossFlatsMm,
      socketDepthMm: dimensions.socketDepthMm,
      target: {
        componentId: target.component.id,
        interfaceType: "hole",
        interfaceId: target.item.id,
        openingSide: directionSign,
      },
      flipped: Boolean(operation.flip),
    },
    interfaces: { holes: [], planes: [], shafts: [], seats: [], edges: [], points: [], centers: [], midplanes: [] },
  };
  operation.componentId = id;
  state.components.push(component);
  return component;
}

function createBearingComponent(state, operation) {
  const series = String(operation.series || "608").toUpperCase();
  const catalogDimensions = BEARING_CATALOG[series];
  const dimensions = {
    innerDiameterMm: Number(operation.innerDiameterMm ?? catalogDimensions?.innerDiameterMm),
    outerDiameterMm: Number(operation.outerDiameterMm ?? catalogDimensions?.outerDiameterMm),
    widthMm: Number(operation.widthMm ?? catalogDimensions?.widthMm),
  };
  if (!Object.values(dimensions).every(Number.isFinite)) {
    throw new HttpError(400, `Bearing dimensions are required for series: ${series}`);
  }
  if (dimensions.innerDiameterMm < .5 || dimensions.innerDiameterMm > 100) {
    throw new HttpError(400, "Bearing inner diameter must be between 0.5 and 100 mm");
  }
  if (dimensions.outerDiameterMm <= dimensions.innerDiameterMm + .5 || dimensions.outerDiameterMm > 250) {
    throw new HttpError(400, "Bearing outer diameter must be larger than the bore and at most 250 mm");
  }
  if (dimensions.widthMm < .5 || dimensions.widthMm > 100) {
    throw new HttpError(400, "Bearing width must be between 0.5 and 100 mm");
  }
  const closure = String(operation.closure || "zz").toLowerCase();
  if (!["open", "zz", "2rs"].includes(closure)) {
    throw new HttpError(400, "Bearing closure must be open, ZZ or 2RS");
  }
  const defaultSealColors = { open: "#c69b46", zz: "#c8cdd1", "2rs": "#202326" };
  const sealColor = String(operation.sealColor || defaultSealColors[closure]).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(sealColor)) throw new HttpError(400, "Invalid bearing seal color");
  const target = snapInterface(state, operation.target);
  if (!["hole", "shaft"].includes(target.type)) {
    throw new HttpError(400, "Bearings can be inserted on hole or shaft magnets");
  }
  const sideKey = target.type === "hole" ? "openingSide" : "endpointSide";
  const side = [-1, 1].includes(Number(target.ref[sideKey])) ? Number(target.ref[sideKey]) : 1;
  const axis = target.item.localAxis;
  const halfLength = target.type === "hole" ? target.item.depthMm / 2 : target.item.lengthMm / 2;
  const localEndpoint = target.item.localCenterMm.map((value, index) => value + axis[index] * halfLength * side);
  const endpoint = transformedPoint(target.component, localEndpoint);
  const outward = transformedAxis(target.component, axis).map((value) => value * side);
  const positionMm = endpoint.map((value, index) => value + outward[index] * dimensions.widthMm / 2);
  const quaternionXyzw = quaternionBetweenVectors([0, 0, 1], outward);
  const id = `bearing_${crypto.randomUUID().replaceAll("-", "_")}`;
  const radius = dimensions.outerDiameterMm / 2;
  const component = {
    id, label: `${series}${closure === "open" ? " OPEN" : `-${closure.toUpperCase()}`} bearing`, status: "generated-bearing", kind: "bearing", meshUrl: null,
    triangles: 384,
    sizeMm: [dimensions.outerDiameterMm, dimensions.outerDiameterMm, dimensions.widthMm],
    baseBoundsMm: {
      min: [positionMm[0] - radius, positionMm[1] - radius, positionMm[2] - dimensions.widthMm / 2],
      max: [positionMm[0] + radius, positionMm[1] + radius, positionMm[2] + dimensions.widthMm / 2],
      center: jsonClone(positionMm),
    },
    transform: { positionMm, quaternionXyzw },
    baseTransform: { positionMm: jsonClone(positionMm), quaternionXyzw: jsonClone(quaternionXyzw) },
    visible: true, locked: false, color: "#9da3a6", appearance: "steel",
    groupId: ensureBearingsGroup(state),
    bearing: { series, ...dimensions, closure, sealColor, target: { ...target.ref, [sideKey]: side } },
    interfaces: { holes: [], planes: [], shafts: [], seats: [], edges: [], points: [], centers: [], midplanes: [] },
  };
  operation.componentId = id;
  state.components.push(component);
  return component;
}

function replaceParametricComponent(state, existing, generated) {
  state.components = state.components.filter((item) => item !== generated);
  const preserved = {
    id: existing.id,
    groupId: existing.groupId,
    color: existing.color,
    appearance: existing.appearance,
    opacity: existing.opacity,
    visible: existing.visible,
    locked: existing.locked,
  };
  Object.assign(existing, generated, preserved);
  return existing;
}

function updateFastenerComponent(state, operation) {
  const existing = componentById(state, String(operation.componentId || ""));
  if (existing.kind !== "fastener") throw new HttpError(400, "Selected component is not a fastener");
  if (existing.locked) throw new HttpError(409, `${existing.label} is locked as a reference`);
  const target = jsonClone(existing.fastener.target);
  if (existing.fastener.flipped) target.openingSide *= -1;
  const generated = createFastenerComponent(state, {
    ...operation,
    type: "add_fastener",
    target,
  });
  operation.componentId = existing.id;
  return replaceParametricComponent(state, existing, generated);
}

function updateBearingComponent(state, operation) {
  const existing = componentById(state, String(operation.componentId || ""));
  if (existing.kind !== "bearing") throw new HttpError(400, "Selected component is not a bearing");
  if (existing.locked) throw new HttpError(409, `${existing.label} is locked as a reference`);
  const generated = createBearingComponent(state, {
    ...operation,
    type: "add_bearing",
    target: jsonClone(existing.bearing.target),
  });
  operation.componentId = existing.id;
  return replaceParametricComponent(state, existing, generated);
}

function ensureGeneratedGroup(state, name, preferredId) {
  const existing = state.groups.find((group) => group.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  let id = preferredId;
  if (state.groups.some((group) => group.id === id)) id = `${preferredId}_${crypto.randomUUID()}`;
  state.groups.push({ id, name });
  return id;
}

function catalogShapeSize(shape) {
  if (shape.type === "motor") {
    return [shape.diameterMm, shape.diameterMm, shape.bodyLengthMm + shape.shaftLengthMm];
  }
  if (shape.type === "servo") {
    return [shape.mountWidthMm, shape.mountDepthMm, shape.heightMm + shape.splineHeightMm];
  }
  return [shape.widthMm, shape.depthMm, shape.heightMm];
}

function dropPositionAboveAssembly(state, sizeMm) {
  const visible = state.components.filter((item) => item.visible);
  if (!visible.length) return [0, 0, sizeMm[2] / 2];
  const bounds = visible.map(componentAabb);
  const minimum = [0, 1, 2].map((axis) => Math.min(...bounds.map((box) => box.min[axis])));
  const maximum = [0, 1, 2].map((axis) => Math.max(...bounds.map((box) => box.max[axis])));
  return [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    maximum[2] + sizeMm[2] / 2 + 8,
  ];
}

function createCatalogComponent(state, operation) {
  const definition = RC_COMPONENT_CATALOG.find((item) => item.id === String(operation.catalogId || ""));
  if (!definition) throw new HttpError(404, `Unknown RC catalog component: ${operation.catalogId}`);
  const shape = jsonClone(definition.shape);
  const sizeMm = catalogShapeSize(shape);
  const positionMm = Array.isArray(operation.positionMm)
    ? finiteVector(operation.positionMm, 3, "positionMm") : dropPositionAboveAssembly(state, sizeMm);
  const id = `catalog_${definition.id.replaceAll("-", "_")}_${crypto.randomUUID().replaceAll("-", "_")}`;
  const categoryNames = { motors: "Motors", electronics: "Electronics", steering: "Steering", power: "Power" };
  const colors = { motors: "#3e464d", electronics: "#30343a", steering: "#5a6066", power: "#245cc7" };
  const interfaces = { holes: [], planes: [], shafts: [], seats: [], edges: [], points: [], centers: [], midplanes: [] };
  if (shape.type === "motor") {
    interfaces.shafts.push({
      id: "output-shaft", localCenterMm: [0, 0, shape.bodyLengthMm / 2], localAxis: [0, 0, 1],
      diameterMm: shape.shaftDiameterMm, radiusMm: shape.shaftDiameterMm / 2, lengthMm: shape.shaftLengthMm,
    });
  }
  if (shape.type === "servo") {
    interfaces.shafts.push({
      id: "output-spline", localCenterMm: [shape.widthMm * .28, 0, shape.heightMm / 2], localAxis: [0, 0, 1],
      diameterMm: shape.splineDiameterMm, radiusMm: shape.splineDiameterMm / 2, lengthMm: shape.splineHeightMm,
    });
    for (const xSign of [-1, 1]) for (const ySign of [-1, 1]) {
      interfaces.holes.push({
        id: `mount-${xSign < 0 ? "left" : "right"}-${ySign < 0 ? "rear" : "front"}`,
        localCenterMm: [
          xSign * shape.mountHoleSpacingXmm / 2,
          ySign * shape.mountHoleSpacingYmm / 2,
          shape.mountTabCenterZMm - shape.splineHeightMm / 2,
        ],
        localAxis: [0, 0, 1],
        diameterMm: shape.mountHoleDiameterMm,
        radiusMm: shape.mountHoleDiameterMm / 2,
        depthMm: shape.mountTabThicknessMm,
      });
    }
  }
  const component = {
    id, label: definition.label, status: "generated-rc-catalog", kind: "catalog", meshUrl: null,
    triangles: shape.type === "box" ? 12 : 160,
    sizeMm,
    baseBoundsMm: {
      min: positionMm.map((value, axis) => value - sizeMm[axis] / 2),
      max: positionMm.map((value, axis) => value + sizeMm[axis] / 2),
      center: jsonClone(positionMm),
    },
    transform: { positionMm, quaternionXyzw: [0, 0, 0, 1] },
    baseTransform: { positionMm: jsonClone(positionMm), quaternionXyzw: [0, 0, 0, 1] },
    visible: true, locked: false, color: colors[definition.category] || "#6b737a", appearance: "default",
    groupId: ensureGeneratedGroup(state, categoryNames[definition.category] || "RC Components", "rc-components"),
    catalog: { id: definition.id, category: definition.category, scale: definition.scale, description: definition.description, shape },
    interfaces,
  };
  operation.componentId = id;
  state.components.push(component);
  return component;
}

function createTurnbuckleComponent(state, operation) {
  const first = snapInterface(state, operation.first);
  const second = snapInterface(state, operation.second);
  if (first.type !== "hole" || second.type !== "hole") throw new HttpError(400, "Turnbuckles require two hole magnets");
  const openingPoint = (target) => {
    const side = [-1, 1].includes(Number(target.ref.openingSide)) ? Number(target.ref.openingSide) : 1;
    const local = target.item.localCenterMm.map(
      (value, axis) => value + target.item.localAxis[axis] * target.item.depthMm * .5 * side,
    );
    return transformedPoint(target.component, local);
  };
  const start = openingPoint(first);
  const end = openingPoint(second);
  const direction = end.map((value, axis) => value - start[axis]);
  const anchorDistanceMm = Math.hypot(...direction);
  if (anchorDistanceMm < 12 || anchorDistanceMm > 300) {
    throw new HttpError(400, "Turnbuckle hole distance must be between 12 and 300 mm");
  }
  const rodDiameterMm = Number(operation.rodDiameterMm || 4);
  if (!Number.isFinite(rodDiameterMm) || rodDiameterMm < 1.5 || rodDiameterMm > 12) {
    throw new HttpError(400, "Turnbuckle rod diameter must be between 1.5 and 12 mm");
  }
  const eyeHoleDiameterMm = Number(operation.eyeHoleDiameterMm || Math.max(first.item.diameterMm, second.item.diameterMm));
  if (!Number.isFinite(eyeHoleDiameterMm) || eyeHoleDiameterMm < 1.5 || eyeHoleDiameterMm > 12) {
    throw new HttpError(400, "Turnbuckle eye diameter must be between 1.5 and 12 mm");
  }
  const adjustmentMm = Number(operation.adjustmentMm || 0);
  if (!Number.isFinite(adjustmentMm) || adjustmentMm < -10 || adjustmentMm > 10) {
    throw new HttpError(400, "Turnbuckle adjustment must be between -10 and 10 mm");
  }
  const centerDistanceMm = anchorDistanceMm + adjustmentMm;
  if (centerDistanceMm < 12) throw new HttpError(400, "Adjusted turnbuckle length is too short");
  const endDiameterMm = Math.max(rodDiameterMm * 2.2, eyeHoleDiameterMm + rodDiameterMm * 1.3);
  const rodEndLengthMm = Math.min(Math.max(endDiameterMm * 1.35, 8), centerDistanceMm * .3);
  const adjusterLengthMm = Math.min(Math.max(rodDiameterMm * 3.2, 10), centerDistanceMm * .32);
  const hexAcrossFlatsMm = Math.max(rodDiameterMm * 1.65, 6);
  const positionMm = start.map((value, axis) => (value + end[axis]) / 2);
  const quaternionXyzw = quaternionBetweenVectors([0, 0, 1], direction);
  const id = `turnbuckle_${crypto.randomUUID().replaceAll("-", "_")}`;
  const component = {
    id, label: `Turnbuckle ${centerDistanceMm.toFixed(1)} mm`, status: "generated-turnbuckle", kind: "turnbuckle", meshUrl: null,
    triangles: 256, sizeMm: [endDiameterMm, endDiameterMm, centerDistanceMm + endDiameterMm],
    baseBoundsMm: {
      min: positionMm.map((value, axis) => value - [endDiameterMm / 2, endDiameterMm / 2, (centerDistanceMm + endDiameterMm) / 2][axis]),
      max: positionMm.map((value, axis) => value + [endDiameterMm / 2, endDiameterMm / 2, (centerDistanceMm + endDiameterMm) / 2][axis]),
      center: jsonClone(positionMm),
    },
    transform: { positionMm, quaternionXyzw },
    baseTransform: { positionMm: jsonClone(positionMm), quaternionXyzw: jsonClone(quaternionXyzw) },
    visible: true, locked: false, color: "#a4aaae", appearance: "steel",
    groupId: ensureGeneratedGroup(state, "Steering links", "steering-links"),
    turnbuckle: {
      anchorDistanceMm, centerDistanceMm, adjustmentMm, rodDiameterMm, eyeHoleDiameterMm,
      endDiameterMm, rodEndLengthMm, adjusterLengthMm, hexAcrossFlatsMm,
      first: jsonClone(first.ref), second: jsonClone(second.ref),
    },
    interfaces: { holes: [], planes: [], shafts: [], seats: [], edges: [], points: [], centers: [], midplanes: [] },
  };
  operation.componentId = id;
  state.components.push(component);
  return component;
}

function updateTurnbuckleComponent(state, operation) {
  const existing = componentById(state, String(operation.componentId || ""));
  if (existing.kind !== "turnbuckle") throw new HttpError(400, "Selected component is not a turnbuckle");
  if (existing.locked) throw new HttpError(409, `${existing.label} is locked as a reference`);
  const generated = createTurnbuckleComponent(state, {
    type: "add_turnbuckle",
    first: jsonClone(existing.turnbuckle.first), second: jsonClone(existing.turnbuckle.second),
    rodDiameterMm: operation.rodDiameterMm,
    eyeHoleDiameterMm: operation.eyeHoleDiameterMm,
    adjustmentMm: operation.adjustmentMm,
  });
  generated.transform = jsonClone(existing.transform);
  generated.baseTransform = jsonClone(existing.baseTransform);
  operation.componentId = existing.id;
  return replaceParametricComponent(state, existing, generated);
}

function createDriveshaftComponent(state, operation) {
  const first = snapInterface(state, operation.first);
  const second = snapInterface(state, operation.second);
  if (first.type !== "hole" || second.type !== "hole") throw new HttpError(400, "Driveshafts require two hole magnets");
  const openingPoint = (target) => {
    const side = [-1, 1].includes(Number(target.ref.openingSide)) ? Number(target.ref.openingSide) : 1;
    const local = target.item.localCenterMm.map(
      (value, axis) => value + target.item.localAxis[axis] * target.item.depthMm * .5 * side,
    );
    return transformedPoint(target.component, local);
  };
  const start = openingPoint(first);
  const end = openingPoint(second);
  const direction = end.map((value, axis) => value - start[axis]);
  const centerDistanceMm = Math.hypot(...direction);
  if (centerDistanceMm < 10 || centerDistanceMm > 300) throw new HttpError(400, "Driveshaft length must be between 10 and 300 mm");
  const shaftDiameterMm = Number(operation.shaftDiameterMm || 5);
  const pinDiameterMm = Number(operation.pinDiameterMm || Math.max(1.5, shaftDiameterMm * .36));
  if (!Number.isFinite(shaftDiameterMm) || shaftDiameterMm < 2 || shaftDiameterMm > 16) {
    throw new HttpError(400, "Driveshaft diameter must be between 2 and 16 mm");
  }
  if (!Number.isFinite(pinDiameterMm) || pinDiameterMm < 1 || pinDiameterMm > 8) {
    throw new HttpError(400, "Driveshaft pin diameter must be between 1 and 8 mm");
  }
  const headDiameterMm = Math.max(shaftDiameterMm * 1.65, pinDiameterMm * 2.4);
  const pinLengthMm = headDiameterMm * 1.45;
  const positionMm = start.map((value, axis) => (value + end[axis]) / 2);
  const quaternionXyzw = quaternionBetweenVectors([0, 0, 1], direction);
  const id = `driveshaft_${crypto.randomUUID().replaceAll("-", "_")}`;
  const component = {
    id, label: `Driveshaft ${centerDistanceMm.toFixed(1)} mm`, status: "generated-driveshaft", kind: "driveshaft", meshUrl: null,
    triangles: 384, sizeMm: [pinLengthMm, headDiameterMm, centerDistanceMm + headDiameterMm],
    baseBoundsMm: {
      min: positionMm.map((value, axis) => value - [pinLengthMm / 2, headDiameterMm / 2, (centerDistanceMm + headDiameterMm) / 2][axis]),
      max: positionMm.map((value, axis) => value + [pinLengthMm / 2, headDiameterMm / 2, (centerDistanceMm + headDiameterMm) / 2][axis]),
      center: jsonClone(positionMm),
    },
    transform: { positionMm, quaternionXyzw },
    baseTransform: { positionMm: jsonClone(positionMm), quaternionXyzw: jsonClone(quaternionXyzw) },
    visible: true, locked: false, color: "#8f969b", appearance: "steel",
    groupId: ensureGeneratedGroup(state, "Drivetrain", "drivetrain"),
    driveshaft: {
      centerDistanceMm, shaftDiameterMm, pinDiameterMm, pinLengthMm, headDiameterMm,
      first: jsonClone(first.ref), second: jsonClone(second.ref),
    },
    interfaces: { holes: [], planes: [], shafts: [], seats: [], edges: [], points: [], centers: [], midplanes: [] },
  };
  operation.componentId = id;
  state.components.push(component);
  return component;
}

function updateDriveshaftComponent(state, operation) {
  const existing = componentById(state, String(operation.componentId || ""));
  if (existing.kind !== "driveshaft") throw new HttpError(400, "Selected component is not a driveshaft");
  if (existing.locked) throw new HttpError(409, `${existing.label} is locked as a reference`);
  const generated = createDriveshaftComponent(state, {
    type: "add_driveshaft", first: jsonClone(existing.driveshaft.first), second: jsonClone(existing.driveshaft.second),
    shaftDiameterMm: operation.shaftDiameterMm, pinDiameterMm: operation.pinDiameterMm,
  });
  generated.transform = jsonClone(existing.transform);
  generated.baseTransform = jsonClone(existing.baseTransform);
  operation.componentId = existing.id;
  return replaceParametricComponent(state, existing, generated);
}

function createComponentInstance(state, operation) {
  const source = componentById(state, String(operation.componentId || ""));
  if (!source.meshUrl || ["fastener", "bearing"].includes(source.kind)) {
    throw new HttpError(400, "Only STL components can be duplicated");
  }
  const sourceComponentId = source.instanceOf || source.id;
  const offset = Math.max(8, Math.min(30, Number(source.sizeMm?.[0] || 20) * .2));
  const positionMm = source.transform.positionMm.map((value, index) => value + (index < 2 ? offset : 0));
  const id = `instance_${crypto.randomUUID().replaceAll("-", "_")}`;
  const instance = {
    id,
    label: `${source.label} copy`,
    status: "user-instance",
    kind: "instance",
    instanceOf: sourceComponentId,
    meshUrl: source.meshUrl,
    triangles: source.triangles,
    sizeMm: jsonClone(source.sizeMm),
    baseBoundsMm: jsonClone(source.baseBoundsMm),
    baseTransform: {
      positionMm: jsonClone(positionMm),
      quaternionXyzw: jsonClone(source.transform.quaternionXyzw),
    },
    transform: {
      positionMm,
      quaternionXyzw: jsonClone(source.transform.quaternionXyzw),
    },
    visible: true,
    locked: false,
    color: source.color,
    appearance: source.appearance || "default",
    opacity: Number.isFinite(source.opacity) ? source.opacity : undefined,
    groupId: source.groupId || null,
    interfaces: jsonClone(source.interfaces || {}),
    ...(source.catalogSource ? { catalogSource: jsonClone(source.catalogSource) } : {}),
  };
  operation.createdComponentId = id;
  state.components.push(instance);
  return instance;
}

function transformedAxis(component, localAxis) {
  return normalizeVector(rotateVector(localAxis, component.transform.quaternionXyzw));
}

function holeOpenings(component, hole, requestedSide = null) {
  const numericSide = Number(requestedSide);
  const sides = [-1, 1].includes(numericSide) ? [numericSide] : [-1, 1];
  return sides.map((side) => {
    const localPoint = hole.localCenterMm.map(
      (value, index) => value + hole.localAxis[index] * hole.depthMm * 0.5 * side,
    );
    return { side, point: transformedPoint(component, localPoint) };
  });
}

function holeCompatibility(first, second) {
  const differenceMm = Math.abs(first.diameterMm - second.diameterMm);
  return { compatible: true, differenceMm, toleranceMm: null };
}

function snapInterface(state, ref) {
  const component = componentById(state, String(ref?.componentId || ""));
  if (!component.visible) throw new HttpError(409, `${component.label} is not currently in the assembly`);
  const type = String(ref?.interfaceType || "hole");
  const collections = {
    hole: "holes", plane: "planes", shaft: "shafts", seat: "seats", edge: "edges", point: "points",
    center: "centers", midplane: "midplanes",
  };
  const collection = collections[type];
  if (!collection) throw new HttpError(400, `Unknown snap interface type: ${type}`);
  const id = String(ref?.interfaceId || ref?.holeId || "");
  const item = component.interfaces?.[collection]?.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError(404, `Unknown ${type} interface: ${component.id}/${id}`);
  return { component, type, item, ref: { ...ref, componentId: component.id, interfaceType: type, interfaceId: id } };
}

function axialLocalPointAndDirection(info) {
  const isHole = info.type === "hole";
  const sideField = isHole ? "openingSide" : "endpointSide";
  const side = [-1, 1].includes(Number(info.ref?.[sideField])) ? Number(info.ref[sideField]) : 1;
  const axis = isHole ? info.item.localAxis : info.item.localAxis;
  const length = isHole ? info.item.depthMm : info.item.lengthMm;
  return {
    side,
    // Drive the shaft tip through the selected entrance to the opposite hole
    // opening, producing an insertion instead of entrance-plane contact.
    localPoint: info.item.localCenterMm.map(
      (value, index) => value + axis[index] * length * 0.5 * side * (isHole ? -1 : 1),
    ),
    localDirection: axis.map((value) => value * side),
  };
}

function solvePointNormalMate(sourceInfo, targetInfo, sourcePoint, sourceDirection, targetPoint, targetDirection) {
  const sourceWorldDirection = transformedAxis(sourceInfo.component, sourceDirection);
  const targetWorldDirection = transformedAxis(targetInfo.component, targetDirection).map((value) => -value);
  const deltaRotation = quaternionBetweenVectors(sourceWorldDirection, targetWorldDirection);
  const quaternionXyzw = multiplyQuaternion(deltaRotation, sourceInfo.component.transform.quaternionXyzw);
  const targetWorldPoint = transformedPoint(targetInfo.component, targetPoint);
  const rotatedSourcePoint = rotateVector(sourcePoint, quaternionXyzw);
  const positionMm = targetWorldPoint.map((value, index) => value - rotatedSourcePoint[index]);
  return {
    type: "set_transform",
    componentId: sourceInfo.component.id,
    positionMm,
    quaternionXyzw,
  };
}

function solvePlaneSlideMate(sourceInfo, targetInfo) {
  const sourceWorldNormal = transformedAxis(sourceInfo.component, sourceInfo.item.localNormal);
  const targetWorldNormal = transformedAxis(targetInfo.component, targetInfo.item.localNormal);
  const deltaRotation = quaternionBetweenVectors(sourceWorldNormal, targetWorldNormal.map((value) => -value));
  const quaternionXyzw = multiplyQuaternion(deltaRotation, sourceInfo.component.transform.quaternionXyzw);
  const targetWorldPoint = transformedPoint(targetInfo.component, targetInfo.item.localCenterMm);
  const rotatedSourcePoint = rotateVector(sourceInfo.item.localCenterMm, quaternionXyzw)
    .map((value, index) => value + sourceInfo.component.transform.positionMm[index]);
  const signedDistance = rotatedSourcePoint.reduce(
    (sum, value, index) => sum + (value - targetWorldPoint[index]) * targetWorldNormal[index],
    0,
  );
  return {
    type: "set_transform",
    componentId: sourceInfo.component.id,
    positionMm: sourceInfo.component.transform.positionMm.map(
      (value, index) => value - targetWorldNormal[index] * signedDistance,
    ),
    quaternionXyzw,
  };
}

function localSnapPoint(info) {
  if (["point", "center"].includes(info.type)) return info.item.localPointMm;
  return info.item.localCenterMm;
}

function localSnapDirection(info) {
  if (["plane", "midplane"].includes(info.type)) return info.item.localNormal;
  if (info.type === "edge") return info.item.localDirection;
  return info.item.localAxis;
}

function solvePointMate(sourceInfo, targetInfo, sourcePoint, targetPoint) {
  const targetWorldPoint = transformedPoint(targetInfo.component, targetPoint);
  const rotatedSourcePoint = rotateVector(sourcePoint, sourceInfo.component.transform.quaternionXyzw);
  return {
    type: "set_transform",
    componentId: sourceInfo.component.id,
    positionMm: targetWorldPoint.map((value, index) => value - rotatedSourcePoint[index]),
    quaternionXyzw: sourceInfo.component.transform.quaternionXyzw,
  };
}

function solveLineMate(sourceInfo, targetInfo) {
  const sourceDirection = transformedAxis(sourceInfo.component, localSnapDirection(sourceInfo));
  let targetDirection = transformedAxis(targetInfo.component, localSnapDirection(targetInfo));
  const dot = sourceDirection.reduce((sum, value, index) => sum + value * targetDirection[index], 0);
  if (dot < 0) targetDirection = targetDirection.map((value) => -value);
  const deltaRotation = quaternionBetweenVectors(sourceDirection, targetDirection);
  const quaternionXyzw = multiplyQuaternion(deltaRotation, sourceInfo.component.transform.quaternionXyzw);
  const targetWorldPoint = transformedPoint(targetInfo.component, localSnapPoint(targetInfo));
  const rotatedSourcePoint = rotateVector(localSnapPoint(sourceInfo), quaternionXyzw);
  return {
    type: "set_transform",
    componentId: sourceInfo.component.id,
    positionMm: targetWorldPoint.map((value, index) => value - rotatedSourcePoint[index]),
    quaternionXyzw,
  };
}

function solvePointPlaneMate(sourceInfo, targetInfo) {
  const sourceIsPoint = ["point", "center"].includes(sourceInfo.type);
  if (!sourceIsPoint) {
    return solvePointMate(sourceInfo, targetInfo, localSnapPoint(sourceInfo), localSnapPoint(targetInfo));
  }
  const sourceWorldPoint = transformedPoint(sourceInfo.component, localSnapPoint(sourceInfo));
  const planeWorldPoint = transformedPoint(targetInfo.component, localSnapPoint(targetInfo));
  const normal = transformedAxis(targetInfo.component, localSnapDirection(targetInfo));
  const signedDistance = sourceWorldPoint.reduce(
    (sum, value, index) => sum + (value - planeWorldPoint[index]) * normal[index],
    0,
  );
  return {
    type: "set_transform",
    componentId: sourceInfo.component.id,
    positionMm: sourceInfo.component.transform.positionMm.map(
      (value, index) => value - normal[index] * signedDistance,
    ),
    quaternionXyzw: sourceInfo.component.transform.quaternionXyzw,
  };
}

function solveShaftPlaneTangent(sourceInfo, targetInfo) {
  if (sourceInfo.type !== "shaft") {
    return solvePointMate(sourceInfo, targetInfo, localSnapPoint(sourceInfo), localSnapPoint(targetInfo));
  }
  const planeNormal = transformedAxis(targetInfo.component, localSnapDirection(targetInfo));
  const shaftAxis = transformedAxis(sourceInfo.component, sourceInfo.item.localAxis);
  const dot = shaftAxis.reduce((sum, value, index) => sum + value * planeNormal[index], 0);
  let desiredAxis = shaftAxis.map((value, index) => value - planeNormal[index] * dot);
  if (Math.hypot(...desiredAxis) < 1e-6) {
    const fallback = Math.abs(planeNormal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    desiredAxis = normalizeVector([
      planeNormal[1] * fallback[2] - planeNormal[2] * fallback[1],
      planeNormal[2] * fallback[0] - planeNormal[0] * fallback[2],
      planeNormal[0] * fallback[1] - planeNormal[1] * fallback[0],
    ]);
  } else desiredAxis = normalizeVector(desiredAxis);
  const deltaRotation = quaternionBetweenVectors(shaftAxis, desiredAxis);
  const quaternionXyzw = multiplyQuaternion(deltaRotation, sourceInfo.component.transform.quaternionXyzw);
  const targetPoint = transformedPoint(targetInfo.component, localSnapPoint(targetInfo));
  const desiredCenter = targetPoint.map((value, index) => value + planeNormal[index] * sourceInfo.item.radiusMm);
  const rotatedCenter = rotateVector(sourceInfo.item.localCenterMm, quaternionXyzw);
  return {
    type: "set_transform",
    componentId: sourceInfo.component.id,
    positionMm: desiredCenter.map((value, index) => value - rotatedCenter[index]),
    quaternionXyzw,
  };
}

export function computeSnapMate(state, sourceRef, targetRef, options = {}) {
  let source = snapInterface(state, sourceRef);
  let target = snapInterface(state, targetRef);
  if (source.component.id === target.component.id) {
    throw new HttpError(400, "Snap interfaces must belong to different parts");
  }
  if (source.component.locked) {
    if (target.component.locked) throw new HttpError(409, "Both parts are locked as references");
    [source, target] = [target, source];
  }
  let operation;
  let snapType;
  const planeTypes = new Set(["plane", "midplane"]);
  const pointTypes = new Set(["point", "center"]);
  if (source.type === "hole" && target.type === "hole") {
    const mate = computeHoleMate(
      state,
      { ...source.ref, holeId: source.item.id },
      { ...target.ref, holeId: target.item.id },
    );
    return {
      ...mate,
      snapType: "hole-hole",
      source: { ...mate.source, interfaceType: "hole", interfaceId: mate.source.holeId },
      target: { ...mate.target, interfaceType: "hole", interfaceId: mate.target.holeId },
    };
  }
  if (planeTypes.has(source.type) && planeTypes.has(target.type)) {
    const planeMode = options.planeMode === "slide" ? "slide" : "center";
    operation = planeMode === "slide"
      ? solvePlaneSlideMate(source, target)
      : solvePointNormalMate(
        source,
        target,
        source.item.localCenterMm,
        source.item.localNormal,
        target.item.localCenterMm,
        target.item.localNormal,
      );
    snapType = planeMode === "slide"
      ? (source.type === "midplane" || target.type === "midplane" ? "midplane-slide" : "plane-slide")
      : (source.type === "midplane" || target.type === "midplane" ? "midplane" : "plane-plane");
  } else if ([source.type, target.type].sort().join("-") === "hole-shaft") {
    const sourceAxial = axialLocalPointAndDirection(source);
    const targetAxial = axialLocalPointAndDirection(target);
    operation = solvePointNormalMate(
      source,
      target,
      sourceAxial.localPoint,
      sourceAxial.localDirection,
      targetAxial.localPoint,
      targetAxial.localDirection,
    );
    snapType = "shaft-hole";
  } else if ((source.type === "edge" && target.type === "edge")
    || ([source.type, target.type].every((type) => ["hole", "shaft", "seat"].includes(type)))) {
    operation = solveLineMate(source, target);
    snapType = source.type === "edge" ? "edge-edge"
      : (source.type === "seat" || target.type === "seat" ? "cylindrical-seat" : "axis-axis");
  } else if (pointTypes.has(source.type) && pointTypes.has(target.type)) {
    operation = solvePointMate(source, target, localSnapPoint(source), localSnapPoint(target));
    snapType = "point-point";
  } else if ((pointTypes.has(source.type) && target.type === "edge")
    || (source.type === "edge" && pointTypes.has(target.type))) {
    operation = solvePointMate(source, target, localSnapPoint(source), localSnapPoint(target));
    snapType = "pin-slot";
  } else if ((pointTypes.has(source.type) && planeTypes.has(target.type))
    || (planeTypes.has(source.type) && pointTypes.has(target.type))) {
    operation = solvePointPlaneMate(source, target);
    snapType = source.type === "center" || target.type === "center" ? "center-plane" : "point-plane";
  } else if ((source.type === "shaft" && planeTypes.has(target.type))
    || (planeTypes.has(source.type) && target.type === "shaft")) {
    operation = solveShaftPlaneTangent(source, target);
    snapType = "tangent";
  } else {
    throw new HttpError(409, `Unsupported snap pair: ${source.type} ↔ ${target.type}`);
  }
  const publicRef = (info) => ({
    componentId: info.component.id,
    interfaceType: info.type,
    interfaceId: info.item.id,
    ...(info.ref.openingSide ? { openingSide: Number(info.ref.openingSide) } : {}),
    ...(info.ref.endpointSide ? { endpointSide: Number(info.ref.endpointSide) } : {}),
  });
  return {
    operation,
    snapType,
    source: publicRef(source),
    target: publicRef(target),
    ...(planeTypes.has(source.type) && planeTypes.has(target.type)
      ? { planeMode: options.planeMode === "slide" ? "slide" : "center" }
      : {}),
  };
}

export function computeSnapRotation(state, sourceRef, targetRef, degreesValue, offsetValue = 0) {
  let source = snapInterface(state, sourceRef);
  let target = snapInterface(state, targetRef);
  if (source.component.id === target.component.id) {
    throw new HttpError(400, "Snap interfaces must belong to different parts");
  }
  if (source.component.locked) {
    if (target.component.locked) throw new HttpError(409, "Both parts are locked as references");
    [source, target] = [target, source];
  }
  const degrees = Number(degreesValue);
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 360) throw new HttpError(400, "Snap angle must be between -360 and 360 degrees");
  const offsetMm = Number(offsetValue);
  if (!Number.isFinite(offsetMm) || Math.abs(offsetMm) > 500) throw new HttpError(400, "Snap offset must be between -500 and 500 mm");
  const localAxis = ["plane", "midplane"].includes(target.type)
    ? target.item.localNormal
    : target.type === "edge"
      ? target.item.localDirection
      : ["point", "center"].includes(target.type)
        ? [0, 0, 1]
        : target.item.localAxis;
  const localPivot = localSnapPoint(target);
  const worldAxis = transformedAxis(target.component, localAxis);
  const worldPivot = transformedPoint(target.component, localPivot);
  const deltaRotation = vectorAxisQuaternion(worldAxis, degrees);
  const offset = source.component.transform.positionMm.map(
    (value, index) => value - worldPivot[index],
  );
  const rotatedOffset = rotateVector(offset, deltaRotation);
  const operation = {
    type: "set_transform",
    componentId: source.component.id,
    positionMm: worldPivot.map(
      (value, index) => value + rotatedOffset[index] + worldAxis[index] * offsetMm,
    ),
    quaternionXyzw: multiplyQuaternion(deltaRotation, source.component.transform.quaternionXyzw),
  };
  return { operation, degrees, offsetMm, source: source.ref, target: target.ref };
}

function selectedLocalPoint(info) {
  if (["hole", "shaft"].includes(info.type)) return axialLocalPointAndDirection(info).localPoint;
  return localSnapPoint(info);
}

export function computePatternMate(state, sourceRefs, targetRefs) {
  if (!Array.isArray(sourceRefs) || !Array.isArray(targetRefs)
    || sourceRefs.length !== 2 || targetRefs.length !== 2) {
    throw new HttpError(400, "A two-point pattern requires two source and two target magnets");
  }
  let sources = sourceRefs.map((ref) => snapInterface(state, ref));
  let targets = targetRefs.map((ref) => snapInterface(state, ref));
  if (sources[0].component.id !== sources[1].component.id
    || targets[0].component.id !== targets[1].component.id) {
    throw new HttpError(400, "Each pattern pair must belong to the same part");
  }
  if (sources[0].component.id === targets[0].component.id) {
    throw new HttpError(400, "Pattern magnets must belong to different parts");
  }
  if (sources[0].component.locked) {
    if (targets[0].component.locked) throw new HttpError(409, "Both parts are locked as references");
    [sources, targets] = [targets, sources];
  }
  const sourceLocalPoints = sources.map(selectedLocalPoint);
  const sourceWorldPoints = sourceLocalPoints.map((point) => transformedPoint(sources[0].component, point));
  const targetWorldPoints = targets.map((info) => transformedPoint(info.component, selectedLocalPoint(info)));
  const sourceVector = sourceWorldPoints[1].map((value, index) => value - sourceWorldPoints[0][index]);
  const targetVector = targetWorldPoints[1].map((value, index) => value - targetWorldPoints[0][index]);
  if (Math.hypot(...sourceVector) < 0.1 || Math.hypot(...targetVector) < 0.1) {
    throw new HttpError(400, "Pattern magnets must be distinct");
  }
  const deltaRotation = quaternionBetweenVectors(sourceVector, targetVector);
  const quaternionXyzw = multiplyQuaternion(deltaRotation, sources[0].component.transform.quaternionXyzw);
  const rotatedFirst = rotateVector(sourceLocalPoints[0], quaternionXyzw);
  const positionMm = targetWorldPoints[0].map((value, index) => value - rotatedFirst[index]);
  const operation = {
    type: "set_transform", componentId: sources[0].component.id, positionMm, quaternionXyzw,
  };
  return {
    operation,
    snapType: "two-point-pattern",
    source: sources.map((info) => info.ref),
    target: targets.map((info) => info.ref),
  };
}

export function computeShaftThroughHolesMate(state, shaftRef, firstHoleRef, secondHoleRef) {
  const shaft = snapInterface(state, shaftRef);
  const first = snapInterface(state, firstHoleRef);
  const second = snapInterface(state, secondHoleRef);
  if (!["hole", "shaft"].includes(shaft.type)) {
    throw new HttpError(400, "The first magnet must be a shaft or an axial hole");
  }
  if (!["hole", "seat"].includes(first.type) || !["hole", "seat"].includes(second.type)) {
    throw new HttpError(400, "The two guide magnets must be holes or cylindrical seats");
  }
  if (shaft.component.id === first.component.id || shaft.component.id === second.component.id) {
    throw new HttpError(400, "The shaft and guide holes must belong to different parts");
  }
  if (first.component.id === second.component.id) {
    throw new HttpError(400, "Pick the second guide hole on another part");
  }
  if (shaft.component.locked) throw new HttpError(409, "The shaft is locked and cannot be positioned");

  const firstCenter = transformedPoint(first.component, first.item.localCenterMm);
  const secondCenter = transformedPoint(second.component, second.item.localCenterMm);
  let guideAxis = secondCenter.map((value, index) => value - firstCenter[index]);
  if (Math.hypot(...guideAxis) < .1) throw new HttpError(400, "The two guide holes are too close to define an axis");
  guideAxis = normalizeVector(guideAxis);
  const shaftAxis = transformedAxis(shaft.component, shaft.item.localAxis);
  if (shaftAxis.reduce((sum, value, index) => sum + value * guideAxis[index], 0) < 0) {
    guideAxis = guideAxis.map((value) => -value);
  }
  const deltaRotation = quaternionBetweenVectors(shaftAxis, guideAxis);
  const quaternionXyzw = multiplyQuaternion(deltaRotation, shaft.component.transform.quaternionXyzw);
  const guideMidpoint = firstCenter.map((value, index) => (value + secondCenter[index]) * .5);
  const rotatedShaftCenter = rotateVector(localSnapPoint(shaft), quaternionXyzw);
  const operation = {
    type: "set_transform",
    componentId: shaft.component.id,
    positionMm: guideMidpoint.map((value, index) => value - rotatedShaftCenter[index]),
    quaternionXyzw,
  };
  const publicRef = (info) => ({
    componentId: info.component.id,
    interfaceType: info.type,
    interfaceId: info.item.id,
  });
  return {
    operation,
    snapType: "shaft-through-two-holes",
    source: publicRef(shaft),
    target: [publicRef(first), publicRef(second)],
  };
}

export function computeHoleMate(state, sourceRef, targetRef) {
  let source = componentById(state, String(sourceRef?.componentId || ""));
  let target = componentById(state, String(targetRef?.componentId || ""));
  if (source.id === target.id) throw new HttpError(400, "The holes must belong to different parts");
  if (!source.visible || !target.visible) {
    throw new HttpError(409, "Both parts must be in the assembly before mating holes");
  }
  if (source.locked) {
    if (target.locked) throw new HttpError(409, "Both parts are locked as references");
    [source, target] = [target, source];
    [sourceRef, targetRef] = [targetRef, sourceRef];
  }
  const sourceHole = holeById(source, String(sourceRef?.holeId || ""));
  const targetHole = holeById(target, String(targetRef?.holeId || ""));
  const compatibility = holeCompatibility(sourceHole, targetHole);
  let closest = null;
  for (const sourceOpening of holeOpenings(source, sourceHole, sourceRef?.openingSide)) {
    for (const targetOpening of holeOpenings(target, targetHole, targetRef?.openingSide)) {
      const distance = Math.hypot(...sourceOpening.point.map(
        (value, index) => value - targetOpening.point[index],
      ));
      if (!closest || distance < closest.distanceMm) {
        closest = { sourceOpening, targetOpening, distanceMm: distance };
      }
    }
  }

  let sourceAxis = transformedAxis(source, sourceHole.localAxis);
  let targetAxis = transformedAxis(target, targetHole.localAxis);
  const explicitOpenings = [-1, 1].includes(Number(sourceRef?.openingSide))
    && [-1, 1].includes(Number(targetRef?.openingSide));
  if (explicitOpenings) {
    // External face normals must oppose one another, like two glued faces.
    sourceAxis = sourceAxis.map((value) => value * closest.sourceOpening.side);
    targetAxis = targetAxis.map((value) => -value * closest.targetOpening.side);
  } else {
    const axisDot = sourceAxis.reduce((sum, value, index) => sum + value * targetAxis[index], 0);
    if (axisDot < 0) targetAxis = targetAxis.map((value) => -value);
  }
  const deltaRotation = quaternionBetweenVectors(sourceAxis, targetAxis);
  const quaternionXyzw = multiplyQuaternion(deltaRotation, source.transform.quaternionXyzw);
  const sourceLocalOpening = sourceHole.localCenterMm.map(
    (value, index) => value
      + sourceHole.localAxis[index] * sourceHole.depthMm * 0.5 * closest.sourceOpening.side,
  );
  const rotatedSourceOpening = rotateVector(sourceLocalOpening, quaternionXyzw);
  const positionMm = closest.targetOpening.point.map(
    (value, index) => value - rotatedSourceOpening[index],
  );
  const operation = {
    type: "set_transform",
    componentId: source.id,
    positionMm,
    quaternionXyzw,
  };
  return {
    operation,
    compatibility,
    distanceBeforeMm: closest.distanceMm,
    source: {
      componentId: source.id,
      holeId: sourceHole.id,
      openingSide: closest.sourceOpening.side,
      diameterMm: sourceHole.diameterMm,
    },
    target: {
      componentId: target.id,
      holeId: targetHole.id,
      openingSide: closest.targetOpening.side,
      diameterMm: targetHole.diameterMm,
    },
  };
}

export function applyOperation(state, operation) {
  if (!operation || typeof operation !== "object") {
    throw new HttpError(400, "Invalid operation");
  }
  state.groups ||= [];
  const normalizedName = (value, field) => {
    const name = String(value || "").trim();
    if (!name || name.length > 80) throw new HttpError(400, `${field} must contain between 1 and 80 characters`);
    return name;
  };
  if (operation.type === "create_group") {
    const groupId = String(operation.groupId || crypto.randomUUID());
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(groupId)) throw new HttpError(400, "Invalid group ID");
    if (state.groups.some((group) => group.id === groupId)) throw new HttpError(409, "Group ID already exists");
    state.groups.push({ id: groupId, name: normalizedName(operation.name, "Group name") });
    operation.groupId = groupId;
    return `group:${groupId}`;
  }
  if (["rename_group", "delete_group"].includes(operation.type)) {
    const groupId = String(operation.groupId || "");
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) throw new HttpError(404, `Unknown group: ${groupId}`);
    if (operation.type === "rename_group") {
      group.name = normalizedName(operation.name, "Group name");
    } else {
      state.groups = state.groups.filter((item) => item.id !== groupId);
      for (const item of state.components) if (item.groupId === groupId) item.groupId = null;
    }
    return `group:${groupId}`;
  }
  if (operation.type === "rename_ungrouped") {
    state.workspace ||= {};
    state.workspace.ungroupedName = normalizedName(operation.name, "Ungrouped section name");
    return "workspace:ungrouped";
  }
  if (operation.type === "add_fastener") {
    return createFastenerComponent(state, operation).id;
  }
  if (operation.type === "add_bearing") {
    return createBearingComponent(state, operation).id;
  }
  if (operation.type === "update_fastener") {
    return updateFastenerComponent(state, operation).id;
  }
  if (operation.type === "update_bearing") {
    return updateBearingComponent(state, operation).id;
  }
  if (operation.type === "add_catalog_component") {
    return createCatalogComponent(state, operation).id;
  }
  if (operation.type === "add_turnbuckle") {
    return createTurnbuckleComponent(state, operation).id;
  }
  if (operation.type === "update_turnbuckle") {
    return updateTurnbuckleComponent(state, operation).id;
  }
  if (operation.type === "add_driveshaft") {
    return createDriveshaftComponent(state, operation).id;
  }
  if (operation.type === "update_driveshaft") {
    return updateDriveshaftComponent(state, operation).id;
  }
  if (operation.type === "lock_component") {
    const item = componentById(state, String(operation.componentId || ""));
    if (typeof operation.locked !== "boolean") throw new HttpError(400, "Locked state must be boolean");
    item.locked = operation.locked;
    return item.id;
  }
  if (operation.type === "duplicate_component") {
    return createComponentInstance(state, operation).id;
  }
  const component = componentById(state, String(operation.componentId || ""));
  if (component.locked && !["visibility", "color", "material", "opacity", "rename_component", "assign_group"].includes(operation.type)) {
    throw new HttpError(409, `${component.label} is locked as a reference`);
  }
  if (!component.visible && !["visibility", "color", "material", "opacity", "rename_component", "assign_group"].includes(operation.type)) {
    throw new HttpError(409, `${component.label} is not currently in the assembly`);
  }

  const beforeTransform = jsonClone(component.transform);
  if (operation.type === "set_transform") {
    component.transform.positionMm = finiteVector(operation.positionMm, 3, "positionMm");
    component.transform.quaternionXyzw = normalizedQuaternion(operation.quaternionXyzw);
  } else if (operation.type === "transform_delta") {
    const delta = finiteVector(operation.deltaMm, 3, "deltaMm");
    const current = component.transform.positionMm;
    component.transform.positionMm = current.map((value, index) => value + delta[index]);
    const deltaRotation = axisQuaternion(operation.rotationAxis, Number(operation.rotationDegrees));
    component.transform.quaternionXyzw = multiplyQuaternion(
      deltaRotation,
      component.transform.quaternionXyzw,
    );
  } else if (operation.type === "visibility") {
    if (typeof operation.visible !== "boolean") throw new HttpError(400, "Invalid visible value");
    component.visible = operation.visible;
  } else if (operation.type === "color") {
    const color = String(operation.color || "").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, "Color must use #RRGGBB format");
    component.color = color;
  } else if (operation.type === "material") {
    const appearance = String(operation.appearance || "default");
    const allowed = new Set([
      "default", "aluminum", "steel", "carbon", "bronze", "copper",
      "plastic-matte", "plastic-gloss", "rubber",
    ]);
    if (!allowed.has(appearance)) throw new HttpError(400, "Unknown visual material");
    component.appearance = appearance;
  } else if (operation.type === "opacity") {
    const opacity = Number(operation.opacity);
    if (!Number.isFinite(opacity) || opacity < .1 || opacity > 1) {
      throw new HttpError(400, "Opacity must be between 0.1 and 1");
    }
    component.opacity = opacity;
  } else if (operation.type === "rename_component") {
    component.label = normalizedName(operation.name, "Component name");
  } else if (operation.type === "assign_group") {
    const groupId = operation.groupId == null || operation.groupId === "" ? null : String(operation.groupId);
    if (groupId && !state.groups.some((group) => group.id === groupId)) {
      throw new HttpError(404, `Unknown group: ${groupId}`);
    }
    component.groupId = groupId;
  } else {
    throw new HttpError(400, `Unsupported operation type: ${operation.type}`);
  }
  if (["set_transform", "transform_delta"].includes(operation.type)) {
    propagateRigidTransform(state, component.id, beforeTransform, component.transform);
  }
  return component.id;
}

function rotatedHalfExtents(size, quaternion) {
  const [x, y, z, w] = normalizedQuaternion(quaternion);
  const matrix = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ].map(Math.abs);
  const half = size.map((value) => value / 2);
  return [
    matrix[0] * half[0] + matrix[1] * half[1] + matrix[2] * half[2],
    matrix[3] * half[0] + matrix[4] * half[1] + matrix[5] * half[2],
    matrix[6] * half[0] + matrix[7] * half[1] + matrix[8] * half[2],
  ];
}

function componentAabb(component) {
  const center = component.transform.positionMm;
  const half = rotatedHalfExtents(component.sizeMm, component.transform.quaternionXyzw);
  return {
    min: center.map((value, index) => value - half[index]),
    max: center.map((value, index) => value + half[index]),
  };
}

export function approximateCollisions(state, onlyIds = null) {
  const visible = state.components.filter((item) => item.visible);
  const filter = onlyIds ? new Set(onlyIds) : null;
  const collisions = [];
  for (let index = 0; index < visible.length; index += 1) {
    const first = visible[index];
    const a = componentAabb(first);
    for (const second of visible.slice(index + 1)) {
      if (filter && !filter.has(first.id) && !filter.has(second.id)) continue;
      const b = componentAabb(second);
      const overlap = [0, 1, 2].map((axis) =>
        Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]),
      );
      if (overlap.every((value) => value > 0.01)) {
        collisions.push({
          first: first.id,
          firstLabel: first.label,
          second: second.id,
          secondLabel: second.label,
          approximateOverlapMm3: Math.round(overlap.reduce((a, b) => a * b, 1) * 100) / 100,
        });
      }
    }
  }
  return collisions.sort((a, b) => b.approximateOverlapMm3 - a.approximateOverlapMm3);
}

function snapshot(state) {
  return state.components.map(({ id, transform, visible, locked, color, appearance, opacity, label, groupId }) => ({
    id,
    transform: jsonClone(transform),
    visible,
    locked,
    color,
    appearance: appearance || "default",
    opacity,
    label,
    groupId: groupId || null,
  }));
}

function restoreSnapshot(state, items) {
  for (const saved of items) {
    const component = componentById(state, saved.id);
    component.transform = jsonClone(saved.transform);
    component.visible = saved.visible;
    if (typeof saved.locked === "boolean") component.locked = saved.locked;
    if (typeof saved.color === "string") component.color = saved.color;
    if (typeof saved.appearance === "string") component.appearance = saved.appearance;
    if (Number.isFinite(saved.opacity)) component.opacity = saved.opacity;
    if (typeof saved.label === "string") component.label = saved.label;
    if (Object.hasOwn(saved, "groupId")) component.groupId = saved.groupId || null;
  }
}

function editorSnapshot(state) {
  return {
    components: snapshot(state),
    generatedComponents: jsonClone(state.components.filter(isGeneratedComponent)),
    mates: jsonClone(state.mates || []),
    joints: jsonClone(state.joints || []),
    groups: jsonClone(state.groups || []),
    workspace: jsonClone(state.workspace || {}),
  };
}

function restoreEditorSnapshot(state, saved) {
  if (Array.isArray(saved.generatedComponents)) {
    state.components = state.components
      .filter((component) => !isGeneratedComponent(component))
      .concat(jsonClone(saved.generatedComponents));
  }
  restoreSnapshot(state, saved.components || []);
  state.mates = jsonClone(saved.mates || []);
  state.joints = jsonClone(saved.joints || []);
  if (Array.isArray(saved.groups)) state.groups = jsonClone(saved.groups);
  if (saved.workspace && typeof saved.workspace === "object") state.workspace = jsonClone(saved.workspace);
}

function jsonEqual(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

// History v2 stores only the difference required to move between adjacent
// editor states. The old format copied every component and every generated
// solid into every one of 500 entries, turning a small assembly into a 47 MiB
// JSON file that had to be parsed and rewritten for each inserted screw.
function editorDelta(current, target) {
  const currentComponents = new Map((current.components || []).map((item) => [item.id, item]));
  const currentGenerated = new Map((current.generatedComponents || []).map((item) => [item.id, item]));
  const targetGenerated = new Map((target.generatedComponents || []).map((item) => [item.id, item]));
  const replacedGeneratedIds = new Set();
  for (const [id, item] of targetGenerated) {
    const existing = currentGenerated.get(id);
    if (existing && !jsonEqual(existing, item)) replacedGeneratedIds.add(id);
  }
  const delta = {
    components: (target.components || []).filter((item) => {
      const existing = currentComponents.get(item.id);
      return existing && !replacedGeneratedIds.has(item.id) && !jsonEqual(existing, item);
    }),
    removeGeneratedComponentIds: [...currentGenerated.keys()].filter(
      (id) => !targetGenerated.has(id) || replacedGeneratedIds.has(id),
    ),
    restoreGeneratedComponents: [...targetGenerated.values()].filter(
      (item) => !currentGenerated.has(item.id) || replacedGeneratedIds.has(item.id),
    ),
  };
  for (const key of ["mates", "joints", "groups", "workspace"]) {
    if (Object.hasOwn(target, key) && !jsonEqual(current[key], target[key])) {
      delta[key] = jsonClone(target[key]);
    }
  }
  return delta;
}

function applyEditorDelta(state, delta) {
  const removed = new Set(delta.removeGeneratedComponentIds || []);
  if (removed.size) state.components = state.components.filter((item) => !removed.has(item.id));
  const existingIds = new Set(state.components.map((item) => item.id));
  for (const item of delta.restoreGeneratedComponents || []) {
    if (!existingIds.has(item.id)) state.components.push(jsonClone(item));
  }
  restoreSnapshot(state, delta.components || []);
  for (const key of ["mates", "joints", "groups", "workspace"]) {
    if (Object.hasOwn(delta, key)) state[key] = jsonClone(delta[key]);
  }
}

function compactHistoryEntry(entry, before, after) {
  entry.historyVersion = 2;
  entry.undoDelta = editorDelta(after, before);
  entry.redoDelta = editorDelta(before, after);
  for (const key of [
    "before", "beforeGeneratedComponents", "beforeMates", "beforeJoints",
    "beforeGroups", "beforeWorkspace", "after",
  ]) delete entry[key];
}

export function compactHistoryStacks(state) {
  ensureHistoryStacks(state);
  const legacyHistory = state.history.some((entry) => entry.historyVersion !== 2);
  if (legacyHistory) {
    const beforeStates = state.history.map((entry) => snapshotFromHistoryEntry(entry));
    const current = editorSnapshot(state);
    for (let index = 0; index < state.history.length; index += 1) {
      const entry = state.history[index];
      if (entry.historyVersion === 2) continue;
      compactHistoryEntry(entry, beforeStates[index], beforeStates[index + 1] || current);
    }
  }
  for (const entry of state.redoStack) {
    if (entry.historyVersion === 2 || !entry.after) continue;
    compactHistoryEntry(entry, snapshotFromHistoryEntry(entry), entry.after);
  }
}

function relationReferencesKnownComponents(value, componentIds) {
  if (!value || typeof value !== "object") return true;
  if (typeof value.componentId === "string" && !componentIds.has(value.componentId)) return false;
  return Object.values(value).every((child) => relationReferencesKnownComponents(child, componentIds));
}

export function loadProjectIntoState(state, project) {
  if (!project || project.format !== "rc-car-assembly-project" || Number(project.version) !== 1) {
    throw new HttpError(400, "Unsupported project file");
  }
  const saved = project.assembly;
  if (!saved || !Array.isArray(saved.components) || saved.components.length > 1000) {
    throw new HttpError(400, "Invalid project components");
  }
  const normalizedName = (value, field) => {
    const name = String(value || "").trim();
    if (!name || name.length > 80) throw new HttpError(400, `${field} must contain between 1 and 80 characters`);
    return name;
  };
  const groups = Array.isArray(saved.groups) ? saved.groups : [];
  if (groups.length > 200) throw new HttpError(400, "Too many project groups");
  const groupIds = new Set();
  state.groups = groups.map((group) => {
    const id = String(group?.id || "");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || groupIds.has(id)) throw new HttpError(400, "Invalid project group ID");
    groupIds.add(id);
    return { id, name: normalizedName(group.name, "Group name") };
  });
  state.workspace = {
    ...(state.workspace || {}),
    ungroupedName: saved.workspace?.ungroupedName
      ? normalizedName(saved.workspace.ungroupedName, "Ungrouped section name")
      : undefined,
  };

  state.components = state.components.filter((component) => !isGeneratedComponent(component));
  const currentById = new Map(state.components.map((component) => [component.id, component]));
  const savedFasteners = [];
  const savedBearings = [];
  const savedInstances = [];
  const savedCatalogComponents = [];
  const savedTurnbuckles = [];
  const savedDriveshafts = [];
  for (const item of saved.components) {
    if (item?.kind === "fastener") { savedFasteners.push(item); continue; }
    if (item?.kind === "bearing") { savedBearings.push(item); continue; }
    if (item?.kind === "instance") { savedInstances.push(item); continue; }
    if (item?.kind === "catalog") { savedCatalogComponents.push(item); continue; }
    if (item?.kind === "turnbuckle") { savedTurnbuckles.push(item); continue; }
    if (item?.kind === "driveshaft") { savedDriveshafts.push(item); continue; }
    const component = currentById.get(String(item?.id || ""));
    if (!component) continue;
    component.transform = {
      positionMm: finiteVector(item.transform?.positionMm, 3, "positionMm"),
      quaternionXyzw: normalizedQuaternion(item.transform?.quaternionXyzw),
    };
    if (typeof item.visible !== "boolean") throw new HttpError(400, "Invalid component visibility");
    component.visible = item.visible;
    if (typeof item.locked === "boolean") component.locked = item.locked;
    component.label = normalizedName(item.label || component.label, "Component name");
    const color = String(item.color || component.color).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, "Invalid component color");
    component.color = color;
    if (typeof item.appearance === "string") component.appearance = item.appearance;
    if (Number.isFinite(item.opacity) && item.opacity >= .1 && item.opacity <= 1) component.opacity = item.opacity;
    const groupId = item.groupId == null || item.groupId === "" ? null : String(item.groupId);
    component.groupId = groupIds.has(groupId) ? groupId : null;
  }

  for (const savedFastener of savedFasteners) {
    const targetComponent = componentById(state, String(savedFastener.fastener?.target?.componentId || ""));
    const targetVisibility = targetComponent.visible;
    targetComponent.visible = true;
    let generated;
    try {
      generated = createFastenerComponent(state, {
        type: "add_fastener",
        target: savedFastener.fastener.target,
        standard: savedFastener.fastener.standard,
        diameterMm: savedFastener.fastener.diameterMm,
        lengthMm: savedFastener.fastener.lengthMm,
        flip: false,
      });
    } finally {
      targetComponent.visible = targetVisibility;
    }
    const requestedId = String(savedFastener.id || "");
    if (!/^fastener_[a-zA-Z0-9_-]{1,100}$/.test(requestedId)
      || state.components.some((component) => component !== generated && component.id === requestedId)) {
      throw new HttpError(400, "Invalid project fastener ID");
    }
    generated.id = requestedId;
    generated.label = normalizedName(savedFastener.label || generated.label, "Fastener name");
    generated.transform = {
      positionMm: finiteVector(savedFastener.transform?.positionMm, 3, "positionMm"),
      quaternionXyzw: normalizedQuaternion(savedFastener.transform?.quaternionXyzw),
    };
    generated.visible = typeof savedFastener.visible === "boolean" ? savedFastener.visible : true;
    generated.locked = Boolean(savedFastener.locked);
    const color = String(savedFastener.color || generated.color).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, "Invalid fastener color");
    generated.color = color;
    if (typeof savedFastener.appearance === "string") generated.appearance = savedFastener.appearance;
    if (Number.isFinite(savedFastener.opacity)) generated.opacity = savedFastener.opacity;
    generated.groupId = groupIds.has(savedFastener.groupId) ? savedFastener.groupId : generated.groupId;
  }

  for (const savedBearing of savedBearings) {
    const generated = createBearingComponent(state, {
      type: "add_bearing", target: savedBearing.bearing?.target, series: savedBearing.bearing?.series,
      innerDiameterMm: savedBearing.bearing?.innerDiameterMm,
      outerDiameterMm: savedBearing.bearing?.outerDiameterMm,
      widthMm: savedBearing.bearing?.widthMm,
      closure: savedBearing.bearing?.closure,
      sealColor: savedBearing.bearing?.sealColor,
    });
    const requestedId = String(savedBearing.id || "");
    if (!/^bearing_[a-zA-Z0-9_-]{1,100}$/.test(requestedId)
      || state.components.some((component) => component !== generated && component.id === requestedId)) {
      throw new HttpError(400, "Invalid project bearing ID");
    }
    generated.id = requestedId;
    generated.label = normalizedName(savedBearing.label || generated.label, "Bearing name");
    generated.transform = {
      positionMm: finiteVector(savedBearing.transform?.positionMm, 3, "positionMm"),
      quaternionXyzw: normalizedQuaternion(savedBearing.transform?.quaternionXyzw),
    };
    generated.visible = typeof savedBearing.visible === "boolean" ? savedBearing.visible : true;
    generated.locked = Boolean(savedBearing.locked);
    const color = String(savedBearing.color || generated.color).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, "Invalid bearing color");
    generated.color = color;
    if (typeof savedBearing.appearance === "string") generated.appearance = savedBearing.appearance;
    if (Number.isFinite(savedBearing.opacity)) generated.opacity = savedBearing.opacity;
    generated.groupId = groupIds.has(savedBearing.groupId) ? savedBearing.groupId : generated.groupId;
  }

  const restoreGeneratedPresentation = (generated, savedItem, idPattern, typeName) => {
    const requestedId = String(savedItem.id || "");
    if (!idPattern.test(requestedId)
      || state.components.some((component) => component !== generated && component.id === requestedId)) {
      throw new HttpError(400, `Invalid project ${typeName} ID`);
    }
    generated.id = requestedId;
    generated.label = normalizedName(savedItem.label || generated.label, `${typeName} name`);
    generated.transform = {
      positionMm: finiteVector(savedItem.transform?.positionMm, 3, "positionMm"),
      quaternionXyzw: normalizedQuaternion(savedItem.transform?.quaternionXyzw),
    };
    generated.visible = typeof savedItem.visible === "boolean" ? savedItem.visible : true;
    generated.locked = Boolean(savedItem.locked);
    const color = String(savedItem.color || generated.color).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, `Invalid ${typeName} color`);
    generated.color = color;
    if (typeof savedItem.appearance === "string") generated.appearance = savedItem.appearance;
    if (Number.isFinite(savedItem.opacity)) generated.opacity = savedItem.opacity;
    generated.groupId = groupIds.has(savedItem.groupId) ? savedItem.groupId : generated.groupId;
  };

  for (const savedCatalog of savedCatalogComponents) {
    const generated = createCatalogComponent(state, {
      type: "add_catalog_component", catalogId: savedCatalog.catalog?.id,
    });
    restoreGeneratedPresentation(generated, savedCatalog, /^catalog_[a-zA-Z0-9_-]{1,160}$/, "catalog component");
  }

  for (const savedTurnbuckle of savedTurnbuckles) {
    const generated = createTurnbuckleComponent(state, {
      type: "add_turnbuckle",
      first: savedTurnbuckle.turnbuckle?.first,
      second: savedTurnbuckle.turnbuckle?.second,
      rodDiameterMm: savedTurnbuckle.turnbuckle?.rodDiameterMm,
      eyeHoleDiameterMm: savedTurnbuckle.turnbuckle?.eyeHoleDiameterMm,
      adjustmentMm: savedTurnbuckle.turnbuckle?.adjustmentMm,
    });
    restoreGeneratedPresentation(generated, savedTurnbuckle, /^turnbuckle_[a-zA-Z0-9_-]{1,120}$/, "turnbuckle");
  }

  for (const savedDriveshaft of savedDriveshafts) {
    const generated = createDriveshaftComponent(state, {
      type: "add_driveshaft",
      first: savedDriveshaft.driveshaft?.first,
      second: savedDriveshaft.driveshaft?.second,
      shaftDiameterMm: savedDriveshaft.driveshaft?.shaftDiameterMm,
      pinDiameterMm: savedDriveshaft.driveshaft?.pinDiameterMm,
    });
    restoreGeneratedPresentation(generated, savedDriveshaft, /^driveshaft_[a-zA-Z0-9_-]{1,120}$/, "driveshaft");
  }

  for (const savedInstance of savedInstances) {
    const generated = createComponentInstance(state, {
      type: "duplicate_component", componentId: savedInstance.instanceOf,
    });
    const requestedId = String(savedInstance.id || "");
    if (!/^instance_[a-zA-Z0-9_-]{1,100}$/.test(requestedId)
      || state.components.some((component) => component !== generated && component.id === requestedId)) {
      throw new HttpError(400, "Invalid project component instance ID");
    }
    generated.id = requestedId;
    generated.label = normalizedName(savedInstance.label || generated.label, "Component name");
    generated.transform = {
      positionMm: finiteVector(savedInstance.transform?.positionMm, 3, "positionMm"),
      quaternionXyzw: normalizedQuaternion(savedInstance.transform?.quaternionXyzw),
    };
    generated.visible = typeof savedInstance.visible === "boolean" ? savedInstance.visible : true;
    generated.locked = Boolean(savedInstance.locked);
    const color = String(savedInstance.color || generated.color).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, "Invalid instance color");
    generated.color = color;
    if (typeof savedInstance.appearance === "string") generated.appearance = savedInstance.appearance;
    if (Number.isFinite(savedInstance.opacity)) generated.opacity = savedInstance.opacity;
    generated.groupId = groupIds.has(savedInstance.groupId) ? savedInstance.groupId : null;
  }

  const componentIds = new Set(state.components.map((component) => component.id));
  state.mates = (Array.isArray(saved.mates) ? saved.mates : [])
    .filter((relation) => relationReferencesKnownComponents(relation, componentIds));
  state.joints = (Array.isArray(saved.joints) ? saved.joints : [])
    .filter((relation) => relationReferencesKnownComponents(relation, componentIds));
}

function snapshotFromHistoryEntry(entry) {
  return {
    components: entry.before || [],
    generatedComponents: entry.beforeGeneratedComponents || [],
    mates: entry.beforeMates || [],
    joints: entry.beforeJoints || [],
    ...(Array.isArray(entry.beforeGroups) ? { groups: entry.beforeGroups } : {}),
    ...(entry.beforeWorkspace && typeof entry.beforeWorkspace === "object"
      ? { workspace: entry.beforeWorkspace } : {}),
  };
}

function ensureHistoryStacks(state) {
  if (!Array.isArray(state.history)) state.history = [];
  if (!Array.isArray(state.redoStack)) state.redoStack = [];
}

function trimHistoryStack(stack) {
  if (stack.length > MAX_HISTORY_ENTRIES) stack.splice(0, stack.length - MAX_HISTORY_ENTRIES);
}

function pushHistoryEntry(state, entry) {
  ensureHistoryStacks(state);
  state.history.push(entry);
  trimHistoryStack(state.history);
  state.redoStack = [];
}

function pushDeltaHistoryEntry(state, beforeState, details) {
  const entry = { revision: state.revision, timestamp: new Date().toISOString(), operations: [], ...details };
  compactHistoryEntry(entry, beforeState, editorSnapshot(state));
  pushHistoryEntry(state, entry);
}

function relationUsesComponent(value, componentIds) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.componentId === "string" && componentIds.has(value.componentId)) return true;
  return Object.values(value).some((child) => relationUsesComponent(child, componentIds));
}

function invalidateValidation(state) {
  state.validation.exact = null;
  state.validation.exactRevision = -1;
  state.validation.approximate = approximateCollisions(state);
}

function clientState(state) {
  ensureHistoryStacks(state);
  if (!Array.isArray(state.groups)) state.groups = [];
  if (!state.workspace || typeof state.workspace !== "object") state.workspace = {};
  return {
    ...state,
    history: undefined,
    redoStack: undefined,
    undoDepth: state.history.length,
    redoDepth: state.redoStack.length,
    historyLimit: MAX_HISTORY_ENTRIES,
  };
}

export function undoState(state) {
  ensureHistoryStacks(state);
  const entry = state.history.pop();
  if (!entry) throw new HttpError(409, "No operation to undo");
  if (entry.historyVersion === 2) applyEditorDelta(state, entry.undoDelta);
  else {
    entry.after = editorSnapshot(state);
    restoreEditorSnapshot(state, snapshotFromHistoryEntry(entry));
  }
  state.redoStack.push(entry);
  trimHistoryStack(state.redoStack);
  state.revision += 1;
  invalidateValidation(state);
  return {
    ...clientState(state),
    historyAction: { source: entry.source, metadata: jsonClone(entry.metadata || null) },
  };
}

export function redoState(state) {
  ensureHistoryStacks(state);
  const entry = state.redoStack.pop();
  if (!entry) throw new HttpError(409, "No operation to redo");
  if (entry.historyVersion === 2) applyEditorDelta(state, entry.redoDelta);
  else {
    if (!entry.after) throw new HttpError(409, "Redo data is unavailable for this operation");
    restoreEditorSnapshot(state, entry.after);
    delete entry.after;
  }
  state.history.push(entry);
  trimHistoryStack(state.history);
  state.revision += 1;
  invalidateValidation(state);
  return {
    ...clientState(state),
    historyAction: { source: entry.source, metadata: jsonClone(entry.metadata || null) },
  };
}

async function readState() {
  return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
}

async function atomicWriteJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // The state contains the complete undo history. Pretty-printing it used to
    // inflate a ~23 MiB payload to ~65 MiB and briefly kept both strings alive,
    // which is enough to trigger the OOM killer on small, swapless machines.
    // Compact JSON preserves exactly the same data while substantially reducing
    // heap pressure and disk I/O.
    await fs.writeFile(temporary, JSON.stringify(value), "utf8");
    await fs.rename(temporary, filename);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function compactHistoryFile(filename = DATA_FILE) {
  const state = JSON.parse(await fs.readFile(filename, "utf8"));
  const legacyCount = [...(state.history || []), ...(state.redoStack || [])]
    .filter((entry) => entry.historyVersion !== 2).length;
  if (!legacyCount) return { migratedEntries: 0, bytes: Buffer.byteLength(JSON.stringify(state)) };
  compactHistoryStacks(state);
  await atomicWriteJson(filename, state);
  return {
    migratedEntries: legacyCount,
    bytes: (await fs.stat(filename)).size,
  };
}

function queueMutation(callback) {
  const work = mutationQueue.then(async () => {
    const state = await readState();
    compactHistoryStacks(state);
    const result = await callback(state);
    await atomicWriteJson(DATA_FILE, state);
    return result;
  });
  mutationQueue = work.catch(() => {});
  return work;
}

async function previewOperations(operations) {
  const state = await readState();
  // History is irrelevant to a preview and can be hundreds of snapshots long.
  // Excluding it avoids a second full in-memory copy without changing the
  // persisted state or undo/redo semantics.
  const preview = jsonClone(clientState(state));
  const affected = operations.map((item) => applyOperation(preview, item));
  return {
    revision: state.revision,
    components: preview.components.filter((item) => affected.includes(item.id)),
    collisions: approximateCollisions(preview, affected),
  };
}

async function commitOperations(operations, source = "human", metadata = null) {
  return queueMutation(async (state) => {
    const beforeState = editorSnapshot(state);
    const affected = operations.map((item) => applyOperation(state, item));
    const entry = {
      revision: state.revision,
      timestamp: new Date().toISOString(),
      source,
      operations: jsonClone(operations),
      metadata: metadata ? jsonClone(metadata) : null,
    };
    state.revision += 1;
    state.mates ||= [];
    state.joints ||= [];
    const removed = new Set(
      operations
        .filter((item) => item.type === "visibility" && item.visible === false)
        .map((item) => item.componentId),
    );
    if (removed.size) {
      state.mates = state.mates.filter((mate) => !relationUsesComponent(mate, removed));
      state.joints = state.joints.filter((joint) => !relationUsesComponent(joint, removed));
    }
    const transformed = new Set(
      operations
        .filter((item) => ![
          "visibility", "color", "material", "opacity", "rename_component", "assign_group",
          "create_group", "rename_group", "delete_group",
          "rename_ungrouped", "add_fastener", "add_bearing", "update_fastener", "update_bearing",
          "add_catalog_component", "add_turnbuckle", "update_turnbuckle",
          "add_driveshaft", "update_driveshaft", "duplicate_component", "lock_component",
        ].includes(item.type))
        .map((item) => item.componentId),
    );
    if (!["hole-mate", "snap-rotation"].includes(source)) {
      state.mates = state.mates.filter(
        (mate) => !transformed.has(mate.source.componentId) && !transformed.has(mate.target.componentId),
      );
    }
    if (metadata?.mate) {
      state.mates = state.mates.filter((mate) => !(
        mate.source.componentId === metadata.mate.source.componentId
        && mate.source.holeId === metadata.mate.source.holeId
      ));
      state.mates.push({ ...jsonClone(metadata.mate), createdRevision: state.revision });
    }
    compactHistoryEntry(entry, beforeState, editorSnapshot(state));
    pushHistoryEntry(state, entry);
    invalidateValidation(state);
    return { state: clientState(state), affected };
  });
}

function aiSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      operations: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            componentId: { type: "string" },
            deltaMm: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } },
            rotationAxis: { type: "string", enum: ["x", "y", "z"] },
            rotationDegrees: { type: "number" },
            rationale: { type: "string" },
          },
          required: ["componentId", "deltaMm", "rotationAxis", "rotationDegrees", "rationale"],
        },
      },
    },
    required: ["summary", "operations"],
  };
}

async function proposeWithAi(message, selectedId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HttpError(
      503,
      "OPENAI_API_KEY is not configured; manual assembly remains available",
      "ai_not_configured",
    );
  }
  const state = await readState();
  const componentSummary = state.components.filter((item) => item.visible).map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    locked: item.locked,
    positionMm: item.transform.positionMm,
    sizeMm: item.sizeMm,
  }));
  const knownCollisions = state.validation.exact?.collisions?.slice(0, 20)
    || state.validation.approximate.slice(0, 20);
  const input = {
    selectedComponentId: selectedId || null,
    userRequest: message,
    components: componentSummary,
    knownCollisions,
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4",
      store: false,
      instructions:
        "You are a CAD assistant for an RC car. Propose small, verifiable transformations. "
        + "Use only the supplied IDs, never move locked components, and do not apply changes. "
        + "Translations are millimeter deltas from the current position. Use rotationDegrees=0 "
        + "when rotation is unnecessary. Prefer one operation when sufficient. Reply in English.",
      input: JSON.stringify(input),
      text: {
        format: {
          type: "json_schema",
          name: "assembly_proposal",
          strict: true,
          schema: aiSchema(),
        },
      },
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new HttpError(response.status, payload.error?.message || "OpenAI API error", "ai_error");
  }
  const outputText = payload.output_text || payload.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new HttpError(502, "The AI returned no proposal", "ai_empty");
  const proposal = JSON.parse(outputText);
  const operations = proposal.operations.map((item) => ({
    type: "transform_delta",
    componentId: item.componentId,
    deltaMm: item.deltaMm,
    rotationAxis: item.rotationAxis,
    rotationDegrees: item.rotationDegrees,
    rationale: item.rationale,
  }));
  const preview = await previewOperations(operations);
  return { ...proposal, operations, preview };
}

async function findFreeCadCmd() {
  const candidates = [process.env.FREECADCMD, "/usr/bin/freecadcmd", "/usr/bin/FreeCADCmd"]
    .filter(Boolean);
  try {
    for (const name of await fs.readdir("/tmp")) {
      if (name.startsWith("rc-car-freecad.")) {
        candidates.push(`/tmp/${name}/squashfs-root/usr/bin/freecadcmd`);
      }
    }
  } catch {}
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
    const timeoutMs = options.timeoutMs || 120000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else if (timedOut) reject(new Error(
        `${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)} seconds\n${output}`,
      ));
      else reject(new Error(`${path.basename(command)} fallito (${code ?? signal})\n${output}`));
    });
  });
}

async function availableMemoryMb() {
  try {
    const meminfo = await fs.readFile("/proc/meminfo", "utf8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return match ? Math.floor(Number(match[1]) / 1024) : null;
  } catch {
    return null;
  }
}

async function buildFreeCad(runExactValidation, exportStep = false) {
  const freecadcmd = await findFreeCadCmd();
  if (!freecadcmd) throw new HttpError(503, "freecadcmd was not found; configure FREECADCMD");
  const freeMemoryMb = await availableMemoryMb();
  const minimumMemoryMb = Math.max(256, Number(process.env.FREECAD_MIN_AVAILABLE_MB || 640));
  if (freeMemoryMb != null && freeMemoryMb < minimumMemoryMb) {
    throw new HttpError(
      503,
      `FreeCAD export postponed: ${freeMemoryMb} MiB available, ${minimumMemoryMb} MiB required to avoid OOM`,
      "freecad_low_memory",
    );
  }
  const state = await readState();
  const revision = state.revision;
  await fs.mkdir(BUILD_DIR, { recursive: true });
  const stateSnapshot = path.join(BUILD_DIR, `assembly-r${revision}.json`);
  const outputModel = path.join(BUILD_DIR, `rc_car_assembly-r${revision}.FCStd`);
  const outputStep = exportStep
    ? path.join(BUILD_DIR, `rc_car_assembly-r${revision}.step`)
    : null;
  const reportPath = path.join(BUILD_DIR, `collisions-r${revision}.json`);
  await atomicWriteJson(stateSnapshot, state);
  const applyArgs = [
    "tools/apply_web_assembly_state.py", "--pass", state.baseAssembly, stateSnapshot, outputModel,
  ];
  if (outputStep) applyArgs.push(outputStep);
  const applyLog = await runProcess(freecadcmd, applyArgs, {
    timeoutMs: 300000,
    env: { MALLOC_ARENA_MAX: "2" },
  });
  let exact = null;
  let collisionLog = "";
  if (runExactValidation) {
    collisionLog = await runProcess(
      freecadcmd,
      ["tools/analyze_assembly_collisions.py", "--pass", outputModel, reportPath],
      {
        timeoutMs: 180000,
        env: {
          RC_CAR_COLLISION_EXTRA_MEMORY_MB: "384",
          RC_CAR_COLLISION_TIMEOUT_SECONDS: "20",
        },
      },
    );
    exact = JSON.parse(await fs.readFile(reportPath, "utf8"));
    await queueMutation(async (current) => {
      if (current.revision === revision) {
        current.validation.exact = exact;
        current.validation.exactRevision = revision;
      }
    });
  }
  return {
    revision,
    modelUrl: `/downloads/${path.basename(outputModel)}`,
    stepUrl: outputStep ? `/downloads/${path.basename(outputStep)}` : null,
    reportUrl: runExactValidation ? `/downloads/${path.basename(reportPath)}` : null,
    exact,
    log: `${applyLog}\n${collisionLog}`.trim().slice(-4000),
  };
}

class HttpError extends Error {
  constructor(status, message, code = "request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".stl": "model/stl",
  ".wasm": "application/wasm",
  ".fcstd": "application/octet-stream",
};

async function sendFile(response, root, requestPath, download = false, headOnly = false) {
  const relative = decodeURIComponent(requestPath).replace(/^\/+/, "");
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) throw new HttpError(403, "Percorso vietato");
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat?.isFile()) throw new HttpError(404, "File not found");
  response.writeHead(200, {
    "Content-Type": MIME[path.extname(filename).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": filename.endsWith(".stl") || filename.includes(`${path.sep}vendor${path.sep}`)
      ? "public, max-age=86400"
      : "no-cache",
    ...(download ? { "Content-Disposition": `attachment; filename="${path.basename(filename)}"` } : {}),
  });
  if (headOnly) {
    response.end();
    return;
  }
  (await import("node:fs")).createReadStream(filename).pipe(response);
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/health") {
    const freecadAvailableMemoryMb = await availableMemoryMb();
    return sendJson(response, 200, {
      ok: true,
      aiConfigured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-5.4",
      freecadConfigured: Boolean(await findFreeCadCmd()),
      freecadAvailableMemoryMb,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/catalog/bearings") {
    return sendJson(response, 200, BEARING_CATALOG);
  }
  if (request.method === "GET" && url.pathname === "/api/catalog/rc") {
    return sendJson(response, 200, RC_COMPONENT_CATALOG);
  }
  if (request.method === "GET" && url.pathname === "/api/assembly") {
    return sendJson(response, 200, clientState(await readState()));
  }
  if (request.method === "POST" && url.pathname === "/api/project/load") {
    const body = await readJsonBody(request);
    const result = await queueMutation(async (state) => {
      const beforeState = editorSnapshot(state);
      loadProjectIntoState(state, body.project);
      pushDeltaHistoryEntry(state, beforeState, {
        source: "project-load",
        metadata: { name: String(body.project?.name || "") },
      });
      state.revision += 1;
      invalidateValidation(state);
      return clientState(state);
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/operations/preview") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await previewOperations(body.operations || []));
  }
  if (request.method === "POST" && url.pathname === "/api/operations/apply") {
    const body = await readJsonBody(request);
    if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 20) {
      throw new HttpError(400, "Provide between 1 and 20 operations");
    }
    return sendJson(response, 200, await commitOperations(body.operations, body.source || "human"));
  }
  if (request.method === "POST" && url.pathname === "/api/mates/preview") {
    const body = await readJsonBody(request);
    const state = await readState();
    const mate = computeHoleMate(state, body.source, body.target);
    const preview = await previewOperations([mate.operation]);
    return sendJson(response, 200, { ...mate, preview });
  }
  if (request.method === "POST" && url.pathname === "/api/mates/apply") {
    const body = await readJsonBody(request);
    const state = await readState();
    const mate = computeHoleMate(state, body.source, body.target);
    const result = await commitOperations(
      [mate.operation],
      "hole-mate",
      { mate: { source: mate.source, target: mate.target } },
    );
    return sendJson(response, 200, { ...result, mate });
  }
  if (request.method === "POST" && url.pathname === "/api/snaps/preview") {
    const body = await readJsonBody(request);
    const state = await readState();
    const mate = computeSnapMate(state, body.source, body.target, { planeMode: body.planeMode });
    const preview = await previewOperations([mate.operation]);
    return sendJson(response, 200, { ...mate, preview });
  }
  if (request.method === "POST" && url.pathname === "/api/snaps/apply") {
    const body = await readJsonBody(request);
    const state = await readState();
    const mate = computeSnapMate(state, body.source, body.target, { planeMode: body.planeMode });
    const result = await commitOperations(
      [mate.operation],
      "snap-mate",
      { mate: { snapType: mate.snapType, source: mate.source, target: mate.target } },
    );
    return sendJson(response, 200, { ...result, mate });
  }
  if (request.method === "POST" && url.pathname === "/api/snaps/rotate") {
    const body = await readJsonBody(request);
    const state = await readState();
    const rotation = computeSnapRotation(state, body.source, body.target, body.degrees, body.offsetMm || 0);
    const result = await commitOperations(
      [rotation.operation],
      "snap-rotation",
      { rotation: { degrees: rotation.degrees, offsetMm: rotation.offsetMm } },
    );
    return sendJson(response, 200, { ...result, rotation });
  }
  if (request.method === "POST" && url.pathname === "/api/snaps/pattern/apply") {
    const body = await readJsonBody(request);
    const state = await readState();
    const mate = computePatternMate(state, body.source, body.target);
    const result = await commitOperations(
      [mate.operation],
      "snap-mate",
      { mate: {
        snapType: mate.snapType,
        source: { componentId: mate.source[0].componentId, pattern: mate.source },
        target: { componentId: mate.target[0].componentId, pattern: mate.target },
      } },
    );
    return sendJson(response, 200, { ...result, mate });
  }
  if (request.method === "POST" && url.pathname === "/api/snaps/through/apply") {
    const body = await readJsonBody(request);
    const state = await readState();
    const mate = computeShaftThroughHolesMate(state, body.shaft, body.firstHole, body.secondHole);
    const result = await commitOperations(
      [mate.operation],
      "snap-mate",
      { mate: { snapType: mate.snapType, source: mate.source, target: mate.target } },
    );
    return sendJson(response, 200, { ...result, mate });
  }
  if (request.method === "POST" && url.pathname === "/api/joints/apply") {
    const body = await readJsonBody(request);
    const jointTypes = new Set(["rigid", "hinge", "slider", "ball", "gear", "limits", "lock"]);
    if (!jointTypes.has(body.jointType)) throw new HttpError(400, "Unsupported joint type");
    const result = await queueMutation(async (state) => {
      const sourceRef = Array.isArray(body.source) ? body.source[0] : body.source;
      const sourceComponent = componentById(state, String(sourceRef?.componentId || ""));
      const beforeState = editorSnapshot(state);
      const minimum = body.minimum === "" || body.minimum == null ? null : Number(body.minimum);
      const maximum = body.maximum === "" || body.maximum == null ? null : Number(body.maximum);
      const ratio = body.ratio === "" || body.ratio == null ? null : Number(body.ratio);
      if ([minimum, maximum, ratio].some((value) => value != null && !Number.isFinite(value))) {
        throw new HttpError(400, "Joint parameters must be finite numbers");
      }
      const joint = {
        id: crypto.randomUUID(),
        type: body.jointType,
        source: jsonClone(body.source),
        target: jsonClone(body.target),
        minimum,
        maximum,
        ratio,
        originTransform: jsonClone(sourceComponent.transform),
        createdRevision: state.revision + 1,
      };
      state.joints ||= [];
      state.joints = state.joints.filter((item) => {
        const itemSource = Array.isArray(item.source) ? item.source[0] : item.source;
        return itemSource?.componentId !== sourceComponent.id;
      });
      state.joints.push(joint);
      if (body.jointType === "lock") sourceComponent.locked = true;
      pushDeltaHistoryEntry(state, beforeState, {
        source: "joint",
        metadata: { joint: jsonClone(joint) },
      });
      state.revision += 1;
      invalidateValidation(state);
      return { state: clientState(state), joint };
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/operations/undo") {
    const result = await queueMutation(async (state) => undoState(state));
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/operations/redo") {
    const result = await queueMutation(async (state) => redoState(state));
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/operations/clear") {
    const current = await readState();
    const operations = current.components
      .filter((component) => component.visible)
      .map((component) => ({ type: "visibility", componentId: component.id, visible: false }));
    if (!operations.length) throw new HttpError(409, "The assembly is already empty");
    return sendJson(response, 200, await commitOperations(operations, "clear-assembly"));
  }
  if (request.method === "POST" && url.pathname === "/api/operations/reset") {
    const result = await queueMutation(async (state) => {
      const beforeState = editorSnapshot(state);
      for (const component of state.components) {
        component.transform.positionMm = jsonClone(
          component.baseTransform?.positionMm || component.baseBoundsMm.center,
        );
        component.transform.quaternionXyzw = jsonClone(
          component.baseTransform?.quaternionXyzw || [0, 0, 0, 1],
        );
        component.visible = true;
      }
      state.mates = [];
      state.joints = [];
      pushDeltaHistoryEntry(state, beforeState, { source: "reset" });
      state.revision += 1;
      invalidateValidation(state);
      return clientState(state);
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/validate/approximate") {
    const state = await readState();
    return sendJson(response, 200, { revision: state.revision, collisions: approximateCollisions(state) });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/propose") {
    const body = await readJsonBody(request);
    if (typeof body.message !== "string" || !body.message.trim()) {
      throw new HttpError(400, "Enter a request for the AI");
    }
    return sendJson(response, 200, await proposeWithAi(body.message.trim(), body.selectedId));
  }
  if (request.method === "POST" && url.pathname === "/api/export") {
    return sendJson(response, 200, await buildFreeCad(false));
  }
  if (request.method === "POST" && url.pathname === "/api/export/step") {
    return sendJson(response, 200, await buildFreeCad(false, true));
  }
  if (request.method === "POST" && url.pathname === "/api/validate/exact") {
    return sendJson(response, 200, await buildFreeCad(true));
  }
  if (["GET", "HEAD"].includes(request.method) && url.pathname.startsWith("/downloads/")) {
    return sendFile(
      response,
      BUILD_DIR,
      url.pathname.slice("/downloads/".length),
      true,
      request.method === "HEAD",
    );
  }
  if (["GET", "HEAD"].includes(request.method)) {
    const staticPath = url.pathname === "/" ? "index.html" : url.pathname;
    return sendFile(response, PUBLIC_DIR, staticPath, false, request.method === "HEAD");
  }
  throw new HttpError(404, "Endpoint not found");
}

export function createAppServer() {
  return createServer((request, response) => {
    route(request, response).catch((error) => {
      if (!error.status || error.status >= 500) console.error(error);
      sendJson(response, error.status || 500, {
        error: error.message || "Internal error",
        code: error.code || "internal_error",
      });
    });
  });
}

export function startServer() {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`Assembly Studio: http://${HOST}:${PORT}`);
    console.log(`AI: ${process.env.OPENAI_API_KEY ? "configured" : "not configured"}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer();
}
