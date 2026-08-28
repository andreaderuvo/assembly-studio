#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const [statePath = "webapp/data/assembly.json", manifestPath = "build/mesh_export/stl_manifest.json"] = process.argv.slice(2);
const state = JSON.parse(await fs.readFile(statePath, "utf8"));
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const projectRoot = path.resolve(path.dirname(manifestPath), ".");

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
}

async function stlBounds(filename) {
  const buffer = await fs.readFile(filename);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const include = (x, y, z) => {
    for (const [index, value] of [x, y, z].entries()) {
      min[index] = Math.min(min[index], value);
      max[index] = Math.max(max[index], value);
    }
  };
  const triangles = buffer.length >= 84 ? buffer.readUInt32LE(80) : 0;
  if (84 + triangles * 50 <= buffer.length) {
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      const offset = 84 + triangle * 50 + 12;
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const at = offset + vertex * 12;
        include(buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8));
      }
    }
  } else {
    const text = buffer.toString("utf8");
    for (const match of text.matchAll(/vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi)) {
      include(Number(match[1]), Number(match[2]), Number(match[3]));
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new Error(`No vertices in ${filename}`);
  return { min, max, center: min.map((value, index) => (value + max[index]) / 2) };
}

const known = new Set();
for (const component of state.components) {
  for (const token of [component.id, component.label]) known.add(String(token || "").toLowerCase());
  const stem = String(component.meshUrl || "").split("/").pop().replace(/\.stl$/i, "");
  for (const token of stem.split("__")) known.add(token.toLowerCase());
}
const usedIds = new Set(state.components.map((component) => component.id));
state.groups ||= [];
const groupIds = new Map();
function catalogGroupId(groupName) {
  if (groupIds.has(groupName)) return groupIds.get(groupName);
  const desiredName = `Catalog / ${groupName}`;
  const existing = state.groups.find((group) => group.name === desiredName);
  let id = existing?.id || `catalog_${slug(groupName)}`;
  let suffix = 2;
  while (!existing && state.groups.some((group) => group.id === id)) id = `catalog_${slug(groupName)}_${suffix++}`;
  if (!existing) state.groups.push({ id, name: desiredName });
  groupIds.set(groupName, id);
  return id;
}

let added = 0;
for (const entry of manifest.components) {
  if ([entry.name, entry.label].some((value) => known.has(String(value).toLowerCase()))) continue;
  const filename = path.join(projectRoot, entry.stl);
  const bounds = await stlBounds(filename);
  // The exported STL already contains the object's source placement. The web
  // mesh is centered on load, so its initial transform is the STL world bounds
  // center with an identity rotation.
  const q = [0, 0, 0, 1];
  const positionMm = [...bounds.center];
  let id = `catalog_${slug(entry.name)}`;
  let suffix = 2;
  while (usedIds.has(id)) id = `catalog_${slug(entry.name)}_${suffix++}`;
  usedIds.add(id);
  const sizeMm = entry.size_mm.map(Number);
  state.components.push({
    id,
    label: entry.label,
    status: "catalog-not-placed",
    kind: "catalog-stl",
    group: entry.group,
    groupId: catalogGroupId(entry.group || "ungrouped"),
    meshUrl: `/assets/catalog/${entry.stl}`,
    triangles: Number(entry.triangles || 0),
    sizeMm,
    baseBoundsMm: {
      min: positionMm.map((value, index) => value - sizeMm[index] / 2),
      max: positionMm.map((value, index) => value + sizeMm[index] / 2),
      center: [...positionMm],
    },
    baseTransform: { positionMm: [...positionMm], quaternionXyzw: q },
    transform: { positionMm: [...positionMm], quaternionXyzw: q },
    visible: false,
    locked: false,
    color: "#8e969d",
    catalogSource: { objectName: entry.name, objectType: entry.type, sourceGroup: entry.group },
    interfaces: { holes: [], planes: [], shafts: [], edges: [], points: [], centers: [], midplanes: [] },
  });
  known.add(String(entry.name).toLowerCase());
  known.add(String(entry.label).toLowerCase());
  added += 1;
}

const temporary = `${statePath}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
await fs.rename(temporary, statePath);
console.log(`Imported ${added} missing STL catalog components; total ${state.components.length}`);
