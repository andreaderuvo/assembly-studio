import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOperation,
  approximateCollisions,
  computeHoleMate,
  computePatternMate,
  computeShaftThroughHolesMate,
  computeSnapMate,
  computeSnapRotation,
  loadProjectIntoState,
  redoState,
  undoState,
} from "../server.mjs";

function component(id, center, size, locked = false) {
  return {
    id,
    label: id,
    locked,
    visible: true,
    sizeMm: size,
    transform: { positionMm: center, quaternionXyzw: [0, 0, 0, 1] },
  };
}

function addHole(part, id, center, axis, diameterMm = 3, depthMm = 2) {
  part.interfaces = { holes: [{
    id,
    localCenterMm: center,
    localAxis: axis,
    diameterMm,
    radiusMm: diameterMm / 2,
    depthMm,
  }] };
  return part;
}

test("transform_delta aggiorna posizione e rotazione", () => {
  const state = { components: [component("part", [0, 0, 0], [10, 10, 10])] };
  applyOperation(state, {
    type: "transform_delta",
    componentId: "part",
    deltaMm: [1, 2, 3],
    rotationAxis: "z",
    rotationDegrees: 90,
  });
  assert.deepEqual(state.components[0].transform.positionMm, [1, 2, 3]);
  assert.ok(Math.abs(state.components[0].transform.quaternionXyzw[2] - Math.SQRT1_2) < 1e-9);
});

test("edge-edge allinea direzione e centro degli spigoli", () => {
  const source = component("source", [0, 0, 0], [2, 2, 2]);
  source.interfaces = { edges: [{ id: "edge-a", lengthMm: 10, localCenterMm: [0, 0, 0], localDirection: [1, 0, 0] }] };
  const target = component("target", [5, 6, 7], [2, 2, 2], true);
  target.interfaces = { edges: [{ id: "edge-b", lengthMm: 10, localCenterMm: [0, 0, 0], localDirection: [0, 1, 0] }] };
  const mate = computeSnapMate(
    { components: [source, target] },
    { componentId: "source", interfaceType: "edge", interfaceId: "edge-a" },
    { componentId: "target", interfaceType: "edge", interfaceId: "edge-b" },
  );
  assert.deepEqual(mate.operation.positionMm, [5, 6, 7]);
  assert.equal(mate.snapType, "edge-edge");
});

test("center-plane proietta il centro sulla superficie senza cambiare orientamento", () => {
  const source = component("source", [2, 3, 5], [2, 2, 2]);
  source.interfaces = { centers: [{ id: "center", localPointMm: [0, 0, 0] }] };
  const target = component("target", [0, 0, 0], [10, 10, 1], true);
  target.interfaces = { planes: [{ id: "plane", areaMm2: 100, localCenterMm: [0, 0, 0], localNormal: [0, 0, 1] }] };
  const mate = computeSnapMate(
    { components: [source, target] },
    { componentId: "source", interfaceType: "center", interfaceId: "center" },
    { componentId: "target", interfaceType: "plane", interfaceId: "plane" },
  );
  assert.deepEqual(mate.operation.positionMm, [2, 3, 0]);
  assert.equal(mate.snapType, "center-plane");
});

test("two-point pattern allinea due coppie di fori", () => {
  const source = component("source", [0, 0, 0], [12, 2, 2]);
  source.interfaces = { holes: [
    { id: "a1", localCenterMm: [0, 0, 0], localAxis: [0, 0, 1], depthMm: 2, diameterMm: 3 },
    { id: "a2", localCenterMm: [10, 0, 0], localAxis: [0, 0, 1], depthMm: 2, diameterMm: 3 },
  ] };
  const target = component("target", [100, 0, 0], [2, 12, 2], true);
  target.interfaces = { holes: [
    { id: "b1", localCenterMm: [0, 0, 0], localAxis: [0, 0, 1], depthMm: 2, diameterMm: 3 },
    { id: "b2", localCenterMm: [0, 10, 0], localAxis: [0, 0, 1], depthMm: 2, diameterMm: 3 },
  ] };
  const ref = (componentId, interfaceId) => ({ componentId, interfaceType: "hole", interfaceId, openingSide: 1 });
  const mate = computePatternMate(
    { components: [source, target] },
    [ref("source", "a1"), ref("source", "a2")],
    [ref("target", "b1"), ref("target", "b2")],
  );
  assert.ok(Math.abs(mate.operation.positionMm[0] - 100) < 1e-9);
  assert.ok(Math.abs(mate.operation.quaternionXyzw[2] - Math.SQRT1_2) < 1e-9);
});

test("un asse attraversa due fori appartenenti a supporti diversi", () => {
  const shaft = component("front-shaft", [20, 0, 0], [80, 3, 3]);
  shaft.interfaces = { shafts: [{
    id: "axis", localCenterMm: [2, 0, 0], localAxis: [1, 0, 0], diameterMm: 3, lengthMm: 80,
  }] };
  const left = addHole(component("tower-left", [0, -20, 5], [5, 5, 15]), "guide-left", [0, 0, 0], [0, 1, 0]);
  const right = addHole(component("tower-right", [0, 20, 5], [5, 5, 15]), "guide-right", [0, 0, 0], [0, 1, 0]);
  const mate = computeShaftThroughHolesMate(
    { components: [shaft, left, right] },
    { componentId: "front-shaft", interfaceType: "shaft", interfaceId: "axis" },
    { componentId: "tower-left", interfaceType: "hole", interfaceId: "guide-left" },
    { componentId: "tower-right", interfaceType: "hole", interfaceId: "guide-right" },
  );
  assert.equal(mate.snapType, "shaft-through-two-holes");
  assert.ok(Math.abs(mate.operation.positionMm[0]) < 1e-9);
  assert.ok(Math.abs(mate.operation.positionMm[1] + 2) < 1e-9);
  assert.ok(Math.abs(mate.operation.positionMm[2] - 5) < 1e-9);
  assert.ok(Math.abs(Math.abs(mate.operation.quaternionXyzw[2]) - Math.SQRT1_2) < 1e-9);
});

test("un asse attraversa due sedi cilindriche aperte a semicerchio", () => {
  const shaft = component("front-shaft", [10, 10, 10], [90, 12, 12]);
  shaft.interfaces = { holes: [{
    id: "axial-bore", localCenterMm: [0, 0, 0], localAxis: [0, 1, 0], diameterMm: 3, depthMm: 90,
  }] };
  const seat = (id, y) => {
    const support = component(id, [5, y, 7], [20, 8, 30]);
    support.interfaces = { seats: [{
      id: "open-seat", localCenterMm: [0, 0, 0], localAxis: [0, 1, 0],
      diameterMm: 14, radiusMm: 7, lengthMm: 4, angularSpanDegrees: 180,
    }] };
    return support;
  };
  const left = seat("tower-left", -25);
  const right = seat("tower-right", 25);
  const mate = computeShaftThroughHolesMate(
    { components: [shaft, left, right] },
    { componentId: "front-shaft", interfaceType: "hole", interfaceId: "axial-bore" },
    { componentId: "tower-left", interfaceType: "seat", interfaceId: "open-seat" },
    { componentId: "tower-right", interfaceType: "seat", interfaceId: "open-seat" },
  );
  assert.deepEqual(mate.operation.positionMm, [5, 0, 7]);
  assert.equal(mate.snapType, "shaft-through-two-holes");
});

test("il componente bloccato non può essere spostato", () => {
  const state = { components: [component("chassis", [0, 0, 0], [10, 10, 10], true)] };
  assert.throws(() => applyOperation(state, {
    type: "transform_delta",
    componentId: "chassis",
    deltaMm: [1, 0, 0],
    rotationAxis: "x",
    rotationDegrees: 0,
  }), /locked/);
});

test("il colore è validato e può essere cambiato anche su un componente locked", () => {
  const state = { components: [component("chassis", [0, 0, 0], [10, 10, 10], true)] };
  state.components[0].color = "#8ea4b8";
  applyOperation(state, { type: "color", componentId: "chassis", color: "#FF00AA" });
  assert.equal(state.components[0].color, "#ff00aa");
  assert.throws(
    () => applyOperation(state, { type: "color", componentId: "chassis", color: "red" }),
    /#RRGGBB/,
  );
});

test("un pezzo rimosso resta nel catalogo ma non può essere trasformato", () => {
  const part = component("wheel", [0, 0, 0], [10, 10, 10]);
  const state = { components: [part] };
  applyOperation(state, { type: "visibility", componentId: "wheel", visible: false });
  assert.equal(state.components.length, 1);
  assert.equal(part.visible, false);
  assert.throws(() => applyOperation(state, {
    type: "transform_delta", componentId: "wheel", deltaMm: [1, 0, 0],
    rotationAxis: "x", rotationDegrees: 0,
  }), /not currently in the assembly/);
  applyOperation(state, { type: "visibility", componentId: "wheel", visible: true });
  assert.equal(part.visible, true);
});

test("gruppi e nomi dei componenti sono modificabili senza cambiare gli ID CAD", () => {
  const part = component("wheel_fl", [0, 0, 0], [10, 10, 10], true);
  const state = { components: [part], groups: [] };
  applyOperation(state, { type: "create_group", groupId: "wheels", name: "Wheels" });
  applyOperation(state, { type: "assign_group", componentId: "wheel_fl", groupId: "wheels" });
  applyOperation(state, { type: "rename_component", componentId: "wheel_fl", name: "Front left wheel" });
  applyOperation(state, { type: "rename_group", groupId: "wheels", name: "Running gear" });
  applyOperation(state, { type: "rename_ungrouped", name: "Loose parts" });
  assert.equal(part.id, "wheel_fl");
  assert.equal(part.label, "Front left wheel");
  assert.equal(part.groupId, "wheels");
  assert.equal(state.groups[0].name, "Running gear");
  assert.equal(state.workspace.ungroupedName, "Loose parts");
  applyOperation(state, { type: "delete_group", groupId: "wheels" });
  assert.equal(part.groupId, null);
  assert.equal(state.groups.length, 0);
});

test("una vite parametrica viene inserita sull'apertura esterna del foro", () => {
  const plate = addHole(
    component("plate", [10, 20, 30], [20, 20, 2], true),
    "mount", [0, 0, 0], [0, 0, 1], 3.2, 2,
  );
  const state = { components: [plate], groups: [] };
  const operation = {
    type: "add_fastener",
    target: { componentId: "plate", interfaceType: "hole", interfaceId: "mount", openingSide: 1 },
    standard: "ISO4762", diameterMm: 3, lengthMm: 12,
  };
  const id = applyOperation(state, operation);
  const screw = state.components.find((item) => item.id === id);
  assert.equal(screw.kind, "fastener");
  assert.equal(screw.fastener.standard, "ISO4762");
  assert.equal(screw.fastener.diameterMm, 3);
  assert.deepEqual(screw.transform.positionMm, [10, 20, 26.5]);
  assert.equal(state.groups.find((group) => group.id === screw.groupId).name, "Fasteners");
});

test("undo e redo rimuovono e ripristinano una vite generata", () => {
  const plate = addHole(component("plate", [0, 0, 0], [20, 20, 2], true), "mount", [0, 0, 0], [0, 0, 1], 4.2, 2);
  const state = {
    revision: 1, components: [plate], groups: [], workspace: {}, mates: [], joints: [], redoStack: [],
    validation: { exact: null, exactRevision: -1, approximate: [] }, history: [],
  };
  const before = [{ id: plate.id, transform: plate.transform, visible: true, locked: true }];
  applyOperation(state, {
    type: "add_fastener",
    target: { componentId: "plate", interfaceType: "hole", interfaceId: "mount", openingSide: 1 },
    standard: "ISO10642", diameterMm: 4, lengthMm: 16,
  });
  state.history.push({
    revision: 0, source: "fastener", operations: [], before,
    beforeGeneratedComponents: [], beforeMates: [], beforeJoints: [], beforeGroups: [], beforeWorkspace: {},
  });
  assert.equal(state.components.filter((item) => item.kind === "fastener").length, 1);
  undoState(state);
  assert.equal(state.components.filter((item) => item.kind === "fastener").length, 0);
  redoState(state);
  assert.equal(state.components.filter((item) => item.kind === "fastener").length, 1);
});

test("broad phase AABB individua solo sovrapposizioni", () => {
  const state = { components: [
    component("a", [0, 0, 0], [10, 10, 10]),
    component("b", [8, 0, 0], [10, 10, 10]),
    component("c", [30, 0, 0], [10, 10, 10]),
  ] };
  const collisions = approximateCollisions(state);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].first, "a");
  assert.equal(collisions[0].second, "b");
});

test("hole mate rende coassiali e coincidenti le aperture dei fori", () => {
  const source = addHole(component("source", [0, 0, 0], [4, 4, 2]), "hole-a", [0, 0, 0], [0, 0, 1], 3, 2);
  const target = addHole(component("target", [10, 0, 5], [4, 4, 4], true), "hole-b", [0, 0, 0], [1, 0, 0], 3.2, 4);
  const state = { components: [source, target] };
  const mate = computeHoleMate(
    state,
    { componentId: "source", holeId: "hole-a" },
    { componentId: "target", holeId: "hole-b" },
  );
  applyOperation(state, mate.operation);
  assert.ok(Math.abs(source.transform.positionMm[0] - 7) < 1e-9);
  assert.ok(Math.abs(source.transform.positionMm[1]) < 1e-9);
  assert.ok(Math.abs(source.transform.positionMm[2] - 5) < 1e-9);
  const [qx, qy, qz, qw] = source.transform.quaternionXyzw;
  const rotatedZ = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
  assert.ok(Math.abs(rotatedZ[0] - 1) < 1e-9);
  assert.ok(Math.abs(rotatedZ[1]) < 1e-9);
  assert.ok(Math.abs(rotatedZ[2]) < 1e-9);
});

test("hole mate ignora diametri diversi e usa i centri", () => {
  const first = addHole(component("first", [0, 0, 0], [2, 2, 2]), "small", [0, 0, 0], [0, 0, 1], 2);
  const second = addHole(component("second", [0, 0, 5], [2, 2, 2]), "large", [0, 0, 0], [0, 0, 1], 5);
  const mate = computeHoleMate(
    { components: [first, second] },
    { componentId: "first", holeId: "small" },
    { componentId: "second", holeId: "large" },
  );
  assert.equal(mate.compatibility.compatible, true);
  assert.equal(mate.compatibility.differenceMm, 3);
});

test("hole mate usa le aperture esterne selezionate come superfici di contatto", () => {
  const source = addHole(component("source", [0, 0, 10], [4, 4, 2]), "top", [0, 0, 0], [0, 0, 1], 3, 2);
  const target = addHole(component("target", [0, 0, 0], [4, 4, 2], true), "bottom", [0, 0, 0], [0, 0, 1], 3, 2);
  const state = { components: [source, target] };
  const mate = computeHoleMate(
    state,
    { componentId: "source", holeId: "top", openingSide: -1 },
    { componentId: "target", holeId: "bottom", openingSide: 1 },
  );
  applyOperation(state, mate.operation);
  assert.ok(Math.abs(source.transform.positionMm[2] - 2) < 1e-9);
  assert.equal(mate.source.openingSide, -1);
  assert.equal(mate.target.openingSide, 1);
});

test("plane mate rende coincidenti due superfici con normali opposte", () => {
  const source = component("source", [0, 0, 5], [4, 4, 2]);
  source.interfaces = { planes: [{ id: "face-a", areaMm2: 16, localCenterMm: [0, 0, 0], localNormal: [0, 0, 1] }] };
  const target = component("target", [10, 0, 0], [4, 4, 2], true);
  target.interfaces = { planes: [{ id: "face-b", areaMm2: 16, localCenterMm: [0, 0, 0], localNormal: [0, 0, 1] }] };
  const mate = computeSnapMate(
    { components: [source, target] },
    { componentId: "source", interfaceType: "plane", interfaceId: "face-a" },
    { componentId: "target", interfaceType: "plane", interfaceId: "face-b" },
  );
  applyOperation({ components: [source, target] }, mate.operation);
  assert.deepEqual(source.transform.positionMm.map((value) => Math.round(value)), [10, 0, 0]);
  assert.equal(mate.snapType, "plane-plane");
});

test("plane slide porta le superfici a contatto senza centrarle lateralmente", () => {
  const source = component("source", [2, 3, 5], [4, 4, 2]);
  source.interfaces = { midplanes: [{ id: "middle-a", areaMm2: 16, localCenterMm: [0, 0, 0], localNormal: [0, 0, 1] }] };
  const target = component("target", [10, 20, 0], [4, 4, 2], true);
  target.interfaces = { midplanes: [{ id: "middle-b", areaMm2: 16, localCenterMm: [0, 0, 0], localNormal: [0, 0, 1] }] };
  const mate = computeSnapMate(
    { components: [source, target] },
    { componentId: "source", interfaceType: "midplane", interfaceId: "middle-a" },
    { componentId: "target", interfaceType: "midplane", interfaceId: "middle-b" },
    { planeMode: "slide" },
  );
  applyOperation({ components: [source, target] }, mate.operation);
  assert.deepEqual(source.transform.positionMm.map((value) => Math.round(value)), [2, 3, 0]);
  assert.equal(mate.snapType, "midplane-slide");
  assert.equal(mate.planeMode, "slide");
});

test("shaft-hole mate inserisce la punta fino all'apertura opposta", () => {
  const source = component("shaft-part", [0, 0, 10], [4, 4, 4]);
  source.interfaces = { shafts: [{
    id: "shaft-a", radiusMm: 2, diameterMm: 4, lengthMm: 4,
    localCenterMm: [0, 0, 0], localAxis: [0, 0, 1],
  }] };
  const target = addHole(component("hole-part", [0, 0, 0], [5, 5, 2], true), "hole-a", [0, 0, 0], [0, 0, 1], 8, 2);
  const mate = computeSnapMate(
    { components: [source, target] },
    { componentId: "shaft-part", interfaceType: "shaft", interfaceId: "shaft-a", endpointSide: -1 },
    { componentId: "hole-part", interfaceType: "hole", interfaceId: "hole-a", openingSide: 1 },
  );
  applyOperation({ components: [source, target] }, mate.operation);
  assert.ok(Math.abs(source.transform.positionMm[2] - 1) < 1e-9);
  assert.equal(mate.snapType, "shaft-hole");
});

test("snap rotation ruota attorno al pivot senza spezzare il mate", () => {
  const source = component("source", [1, 0, 0], [2, 2, 2]);
  source.interfaces = { planes: [{ id: "source-face", areaMm2: 4, localCenterMm: [-1, 0, 0], localNormal: [0, 0, -1] }] };
  const target = component("target", [0, 0, 0], [2, 2, 2], true);
  target.interfaces = { planes: [{ id: "target-face", areaMm2: 4, localCenterMm: [0, 0, 0], localNormal: [0, 0, 1] }] };
  const rotation = computeSnapRotation(
    { components: [source, target] },
    { componentId: "source", interfaceType: "plane", interfaceId: "source-face" },
    { componentId: "target", interfaceType: "plane", interfaceId: "target-face" },
    90,
  );
  applyOperation({ components: [source, target] }, rotation.operation);
  assert.ok(Math.abs(source.transform.positionMm[0]) < 1e-9);
  assert.ok(Math.abs(source.transform.positionMm[1] - 1) < 1e-9);
  assert.ok(Math.abs(source.transform.quaternionXyzw[2] - Math.SQRT1_2) < 1e-9);
});

test("uno snap muove il secondo pezzo quando quello scelto per primo è locked", () => {
  const locked = addHole(component("locked", [0, 0, 0], [4, 4, 2], true), "fixed-hole", [0, 0, 0], [0, 0, 1]);
  const movable = addHole(component("movable", [0, 0, 10], [4, 4, 2]), "moving-hole", [0, 0, 0], [0, 0, 1]);
  const mate = computeSnapMate(
    { components: [locked, movable] },
    { componentId: "locked", interfaceType: "hole", interfaceId: "fixed-hole", openingSide: 1 },
    { componentId: "movable", interfaceType: "hole", interfaceId: "moving-hole", openingSide: -1 },
  );
  assert.equal(mate.operation.componentId, "movable");
  assert.equal(mate.source.componentId, "movable");
  applyOperation({ components: [locked, movable] }, mate.operation);
  assert.deepEqual(locked.transform.positionMm, [0, 0, 0]);
  assert.ok(movable.transform.positionMm[2] < 10);
});

test("undo e redo persistono oltre il vecchio limite di 50 operazioni", () => {
  const part = component("part", [80, 0, 0], [2, 2, 2]);
  const savedComponent = (x) => ({
    id: "part",
    transform: { positionMm: [x, 0, 0], quaternionXyzw: [0, 0, 0, 1] },
    visible: true,
    locked: false,
  });
  const state = {
    revision: 80,
    components: [part],
    mates: [],
    joints: [],
    history: Array.from({ length: 80 }, (_, index) => ({
      revision: index,
      source: "test",
      operations: [],
      before: [savedComponent(index)],
      beforeMates: [],
      beforeJoints: [],
    })),
    validation: { exact: null, exactRevision: -1, approximate: [] },
  };
  for (let index = 0; index < 80; index += 1) undoState(state);
  assert.deepEqual(part.transform.positionMm, [0, 0, 0]);
  assert.equal(state.history.length, 0);
  assert.equal(state.redoStack.length, 80);
  for (let index = 0; index < 80; index += 1) redoState(state);
  assert.deepEqual(part.transform.positionMm, [80, 0, 0]);
  assert.equal(state.history.length, 80);
  assert.equal(state.redoStack.length, 0);
});

test("undo e redo comunicano al frontend quando cambia una rotazione snap", () => {
  const part = component("part", [10, 0, 0], [2, 2, 2]);
  const state = {
    revision: 2,
    components: [part], mates: [], joints: [], redoStack: [],
    history: [{
      revision: 1,
      source: "snap-rotation",
      metadata: { rotation: { degrees: 90, offsetMm: 2 } },
      before: [{
        id: "part", visible: true, locked: false,
        transform: { positionMm: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] },
      }],
      beforeMates: [], beforeJoints: [],
    }],
    validation: { exact: null, exactRevision: -1, approximate: [] },
  };
  const undone = undoState(state);
  assert.deepEqual(undone.historyAction, {
    source: "snap-rotation", metadata: { rotation: { degrees: 90, offsetMm: 2 } },
  });
  const redone = redoState(state);
  assert.deepEqual(redone.historyAction, undone.historyAction);
});

test("undo e redo ripristinano il nome personalizzato di Ungrouped", () => {
  const part = component("part", [0, 0, 0], [2, 2, 2]);
  const state = {
    revision: 1, components: [part], groups: [], workspace: { ungroupedName: "Loose parts" },
    mates: [], joints: [], redoStack: [], validation: { exact: null, exactRevision: -1, approximate: [] },
    history: [{
      revision: 0, source: "grouping", operations: [], metadata: null,
      before: [{ id: "part", visible: true, locked: false, transform: part.transform }],
      beforeMates: [], beforeJoints: [], beforeGroups: [], beforeWorkspace: {},
    }],
  };
  undoState(state);
  assert.equal(state.workspace.ungroupedName, undefined);
  redoState(state);
  assert.equal(state.workspace.ungroupedName, "Loose parts");
});

test("un cuscinetto parametrico viene inserito sull'estremità di un asse", () => {
  const shaft = component("shaft", [0, 0, 0], [6, 6, 20]);
  shaft.interfaces = { shafts: [{
    id: "axis", localCenterMm: [0, 0, 0], localAxis: [0, 0, 1],
    diameterMm: 5, radiusMm: 2.5, lengthMm: 20,
  }] };
  const state = { components: [shaft], groups: [], mates: [], joints: [] };
  const id = applyOperation(state, {
    type: "add_bearing", series: "MR105",
    target: { componentId: "shaft", interfaceType: "shaft", interfaceId: "axis", endpointSide: 1 },
  });
  const bearing = state.components.find((item) => item.id === id);
  assert.equal(bearing.kind, "bearing");
  assert.equal(bearing.bearing.innerDiameterMm, 5);
  assert.deepEqual(bearing.transform.positionMm, [0, 0, 12]);
});

test("materiali visivi e progetto portatile sono validati e ripristinati", () => {
  const part = component("part", [0, 0, 0], [2, 2, 2]);
  part.color = "#ffffff";
  const state = { components: [part], groups: [], workspace: {}, mates: [], joints: [] };
  applyOperation(state, { type: "material", componentId: "part", appearance: "carbon" });
  assert.equal(part.appearance, "carbon");
  assert.throws(() => applyOperation(state, { type: "material", componentId: "part", appearance: "wood" }));
  loadProjectIntoState(state, {
    format: "rc-car-assembly-project", version: 1,
    assembly: {
      components: [{
        id: "part", label: "Logical part", visible: false, locked: false,
        color: "#112233", appearance: "copper", groupId: "mechanics",
        transform: { positionMm: [4, 5, 6], quaternionXyzw: [0, 0, 0, 1] },
      }],
      groups: [{ id: "mechanics", name: "Mechanics" }], workspace: { ungroupedName: "Loose" },
      mates: [], joints: [],
    },
  });
  assert.equal(part.label, "Logical part");
  assert.equal(part.appearance, "copper");
  assert.equal(part.groupId, "mechanics");
  assert.deepEqual(part.transform.positionMm, [4, 5, 6]);
});

test("lo stesso STL può creare istanze indipendenti con opacità propria", () => {
  const part = component("catalog-part", [0, 0, 0], [20, 10, 4]);
  Object.assign(part, {
    meshUrl: "/assets/catalog/part.stl", status: "catalog", color: "#111111",
    baseBoundsMm: { min: [-10, -5, -2], max: [10, 5, 2], center: [0, 0, 0] },
    interfaces: { holes: [] }, groupId: null,
  });
  const state = { components: [part], groups: [], mates: [], joints: [] };
  const id = applyOperation(state, { type: "duplicate_component", componentId: part.id });
  const copy = state.components.find((item) => item.id === id);
  assert.equal(copy.kind, "instance");
  assert.equal(copy.instanceOf, part.id);
  assert.equal(copy.meshUrl, part.meshUrl);
  assert.notDeepEqual(copy.transform.positionMm, part.transform.positionMm);
  applyOperation(state, { type: "opacity", componentId: id, opacity: .45 });
  assert.equal(copy.opacity, .45);
  assert.equal(part.opacity, undefined);
});

test("un assemblaggio rigido propaga movimento e rotazione in entrambe le direzioni", () => {
  const motor = component("motor", [0, 0, 0], [20, 20, 20]);
  const pinion = component("pinion", [10, 0, 0], [5, 5, 5]);
  const state = {
    components: [motor, pinion], groups: [], mates: [],
    joints: [{
      id: "rigid", type: "rigid",
      source: { componentId: "pinion" }, target: { componentId: "motor" },
    }],
  };
  applyOperation(state, {
    type: "set_transform", componentId: "motor",
    positionMm: [5, 0, 0], quaternionXyzw: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  });
  assert.deepEqual(pinion.transform.positionMm.map((value) => Math.round(value)), [5, 10, 0]);
  applyOperation(state, {
    type: "set_transform", componentId: "pinion",
    positionMm: [5, 15, 0], quaternionXyzw: pinion.transform.quaternionXyzw,
  });
  assert.deepEqual(motor.transform.positionMm.map((value) => Math.round(value)), [5, 5, 0]);
});
