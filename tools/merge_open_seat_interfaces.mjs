#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

if (process.argv.length !== 4) {
  throw new Error("Usage: node tools/merge_open_seat_interfaces.mjs STATE.json SNAP_INTERFACES.json");
}

const statePath = path.resolve(process.argv[2]);
const reportPath = path.resolve(process.argv[3]);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const extracted = JSON.parse(fs.readFileSync(reportPath, "utf8")).components || {};
const updated = [];

for (const component of state.components || []) {
  const source = extracted[component.id];
  if (!source) continue;
  const center = component.baseBoundsMm.center;
  component.interfaces ||= {};
  component.interfaces.seats = (source.seats || []).map((seat) => ({
    id: seat.id,
    radiusMm: seat.radiusMm,
    diameterMm: seat.diameterMm,
    lengthMm: seat.lengthMm,
    angularSpanDegrees: seat.angularSpanDegrees || 180,
    localCenterMm: seat.centerMm.map((value, axis) => Number((value - center[axis]).toFixed(6))),
    localAxis: seat.axis,
  }));
  updated.push(`${component.id}:${component.interfaces.seats.length}`);
}

const temporaryPath = `${statePath}.seats-${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, statePath);
console.log(`Updated cylindrical seats: ${updated.join(", ")}`);
