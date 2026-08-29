import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";
import { TransformControls } from "/vendor/TransformControls.js";
import { STLLoader } from "/vendor/STLLoader.js";
import { mergeGeometries } from "/vendor/BufferGeometryUtils.js";
import {
  availableLocales, currentLocale, downloadLocaleTemplate, importLocaleFile,
  initI18n, setLocale, t,
} from "/i18n.js";

await initI18n();

const $ = (selector) => document.querySelector(selector);
const viewport = $("#viewport");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1117);
scene.fog = new THREE.Fog(0x0b1117, 500, 1000);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2500);
camera.up.set(0, 0, 1);
camera.position.set(430, -390, 300);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1;
// Editor meshes do not cast shadows, so a shadow map only wastes GPU memory.
renderer.shadowMap.enabled = false;
viewport.prepend(renderer.domElement);

const environmentCanvas = document.createElement("canvas");
environmentCanvas.width = 512;
environmentCanvas.height = 256;
const environmentContext = environmentCanvas.getContext("2d");
const environmentGradient = environmentContext.createLinearGradient(0, 0, 0, 256);
// Keep reflections broad and neutral. The previous environment contained two
// bright rectangular "softboxes"; on metal parts they looked like headlights,
// especially in high-resolution PNG exports.
environmentGradient.addColorStop(0, "#b8bdc1");
environmentGradient.addColorStop(.42, "#7f868b");
environmentGradient.addColorStop(1, "#4e555a");
environmentContext.fillStyle = environmentGradient;
environmentContext.fillRect(0, 0, 512, 256);
const environmentTexture = new THREE.CanvasTexture(environmentCanvas);
environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
environmentTexture.colorSpace = THREE.SRGBColorSpace;
scene.environment = environmentTexture;

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 0, 30);

const transform = new TransformControls(camera, renderer.domElement);
const transformHelper = transform.getHelper ? transform.getHelper() : transform;
scene.add(transformHelper);
transform.setTranslationSnap(0.5);
transform.setRotationSnap(THREE.MathUtils.degToRad(5));
transform.setSize(0.8);

const lightLevels = { hemisphere: .9, key: .8, fill: .32 };
const hemisphereLight = new THREE.HemisphereLight(0xdbe8ef, 0x343a40, lightLevels.hemisphere);
scene.add(hemisphereLight);
const keyLight = new THREE.DirectionalLight(0xffffff, lightLevels.key);
keyLight.position.set(-220, -180, 420);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xc4d0d8, lightLevels.fill);
fillLight.position.set(250, 180, 160);
scene.add(fillLight);

const grid = new THREE.GridHelper(700, 70, 0x345064, 0x1b2a35);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.2;
scene.add(grid);
const axes = new THREE.AxesHelper(55);
scene.add(axes);

const viewCubeCanvas = $("#viewCubeCanvas");
const viewCubeContext = viewCubeCanvas.getContext("2d");
const viewCubeVertices = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const viewCubeFaces = [
  { id: "bottom", vertices: [0, 3, 2, 1], direction: [0, 0, -1], label: "BOTTOM" },
  { id: "top", vertices: [4, 5, 6, 7], direction: [0, 0, 1], label: "TOP" },
  { id: "front", vertices: [0, 4, 7, 3], direction: [-1, 0, 0], label: "FRONT" },
  { id: "rear", vertices: [1, 2, 6, 5], direction: [1, 0, 0], label: "REAR" },
  { id: "left", vertices: [0, 1, 5, 4], direction: [0, -1, 0], label: "LEFT" },
  { id: "right", vertices: [3, 7, 6, 2], direction: [0, 1, 0], label: "RIGHT" },
];
const viewCubeEdges = [];
for (let first = 0; first < viewCubeVertices.length; first += 1) {
  for (let second = first + 1; second < viewCubeVertices.length; second += 1) {
    const differences = viewCubeVertices[first].filter((value, axis) => value !== viewCubeVertices[second][axis]).length;
    if (differences === 1) viewCubeEdges.push([first, second]);
  }
}
let viewCubeRegions = [];
let hoveredViewCubeRegion = null;
let viewCubeRenderKey = "";
let viewCubeDrag = null;

function stableViewDirection(direction) {
  const normalized = direction.clone().normalize();
  // An exactly vertical camera cannot also use Z as its up axis. Keep the
  // global CAD convention and introduce an invisible, deterministic tilt.
  if (Math.abs(normalized.z) > .99999) {
    normalized.y = -Math.sign(normalized.z || 1) * 1e-5;
    normalized.normalize();
  }
  return normalized;
}

function stableViewUp() {
  return new THREE.Vector3(0, 0, 1);
}

function setCameraDirection(direction, fit = false) {
  const normalized = stableViewDirection(direction);
  if (!Number.isFinite(normalized.x + normalized.y + normalized.z) || normalized.lengthSq() < .5) return;
  if (fit) {
    fitView(normalized, stableViewUp());
    return;
  }
  const distance = Math.max(camera.position.distanceTo(orbit.target), 1);
  camera.up.copy(stableViewUp());
  camera.position.copy(orbit.target).addScaledVector(normalized, distance);
  camera.lookAt(orbit.target);
  camera.updateMatrixWorld();
  orbit.update();
  viewCubeRenderKey = "";
}

function orbitFromViewCube(deltaX, deltaY) {
  const offset = camera.position.clone().sub(orbit.target);
  const distance = Math.max(offset.length(), 1);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= deltaX * .012;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - deltaY * .012, .035, Math.PI - .035);
  camera.up.set(0, 0, 1);
  camera.position.copy(orbit.target).add(offset.setFromSpherical(spherical).setLength(distance));
  camera.lookAt(orbit.target);
  camera.updateMatrixWorld();
  orbit.update();
  viewCubeRenderKey = "";
}

function rollCamera(angle) {
  const viewAxis = orbit.target.clone().sub(camera.position).normalize();
  camera.up.applyAxisAngle(viewAxis, angle).normalize();
  camera.lookAt(orbit.target);
  camera.updateMatrixWorld();
  viewCubeRenderKey = "";
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [xi, yi] = polygon[index]; const [xj, yj] = polygon[previous];
    if (((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point, first, second) {
  const dx = second[0] - first[0]; const dy = second[1] - first[1];
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared ? THREE.MathUtils.clamp(
    ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / lengthSquared, 0, 1,
  ) : 0;
  return Math.hypot(point[0] - first[0] - dx * ratio, point[1] - first[1] - dy * ratio);
}

function viewCubeRegionAt(point) {
  const roll = viewCubeRegions.filter((region) => region.type === "roll")
    .find((region) => Math.hypot(point[0] - region.point[0], point[1] - region.point[1]) < 17);
  if (roll) return roll;
  const corners = viewCubeRegions.filter((region) => region.type === "corner" && region.depth > -.2)
    .sort((a, b) => b.depth - a.depth);
  const corner = corners.find((region) => Math.hypot(point[0] - region.point[0], point[1] - region.point[1]) < 12);
  if (corner) return corner;
  const edges = viewCubeRegions.filter((region) => region.type === "edge" && region.depth > -.2)
    .sort((a, b) => b.depth - a.depth);
  const edge = edges.find((region) => pointSegmentDistance(point, region.points[0], region.points[1]) < 8);
  if (edge) return edge;
  return viewCubeRegions.filter((region) => region.type === "face")
    .sort((a, b) => b.depth - a.depth).find((region) => pointInPolygon(point, region.points)) || null;
}

function renderViewCube() {
  const renderKey = `${camera.quaternion.toArray().map((value) => value.toFixed(4)).join(",")}:${hoveredViewCubeRegion?.id || ""}`;
  if (renderKey === viewCubeRenderKey) return;
  viewCubeRenderKey = renderKey;
  const width = viewCubeCanvas.width; const height = viewCubeCanvas.height;
  viewCubeContext.clearRect(0, 0, width, height);
  const centerX = width / 2; const centerY = height / 2;
  viewCubeContext.strokeStyle = "rgba(210,210,210,.32)";
  viewCubeContext.lineWidth = 2;
  viewCubeContext.beginPath();
  viewCubeContext.arc(centerX, centerY, 104, 0, Math.PI * 2);
  viewCubeContext.stroke();
  const inverseCamera = camera.quaternion.clone().invert();
  const projected = viewCubeVertices.map((values) => {
    const point = new THREE.Vector3(...values).applyQuaternion(inverseCamera);
    return { point: [width / 2 + point.x * 55, height / 2 - point.y * 55], depth: point.z };
  });
  const faceRegions = viewCubeFaces.map((face) => ({
    ...face, type: "face", points: face.vertices.map((index) => projected[index].point),
    depth: face.vertices.reduce((sum, index) => sum + projected[index].depth, 0) / 4,
  })).sort((a, b) => a.depth - b.depth);
  for (const face of faceRegions) {
    const active = hoveredViewCubeRegion?.type === "face" && hoveredViewCubeRegion.id === face.id;
    const brightness = Math.round(76 + (face.depth + 1) * 34);
    viewCubeContext.fillStyle = active ? "#d8d8d8" : `rgb(${brightness},${brightness},${brightness})`;
    viewCubeContext.strokeStyle = active ? "#ffffff" : "#2c2c2c";
    viewCubeContext.lineWidth = active ? 4 : 2;
    viewCubeContext.beginPath();
    viewCubeContext.moveTo(...face.points[0]);
    face.points.slice(1).forEach((point) => viewCubeContext.lineTo(...point));
    viewCubeContext.closePath(); viewCubeContext.fill(); viewCubeContext.stroke();
    if (face.depth > -.05) {
      const center = face.points.reduce((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4], [0, 0]);
      viewCubeContext.fillStyle = active ? "#111" : "#ececec";
      viewCubeContext.font = "600 17px system-ui";
      viewCubeContext.textAlign = "center"; viewCubeContext.textBaseline = "middle";
      viewCubeContext.fillText(face.label, center[0], center[1]);
    }
  }
  const cornerRegions = projected.map((vertex, index) => ({
    type: "corner", id: `corner-${index}`, point: vertex.point, depth: vertex.depth,
    direction: viewCubeVertices[index],
  }));
  const edgeRegions = viewCubeEdges.map(([first, second]) => ({
    type: "edge", id: `edge-${first}-${second}`,
    points: [projected[first].point, projected[second].point],
    depth: (projected[first].depth + projected[second].depth) / 2,
    direction: viewCubeVertices[first].map((value, axis) => (value + viewCubeVertices[second][axis]) / 2),
  }));
  for (const edge of edgeRegions.filter((item) => item.depth > -.2)) {
    const active = hoveredViewCubeRegion?.id === edge.id;
    viewCubeContext.strokeStyle = active ? "#fff" : "rgba(220,220,220,.46)";
    viewCubeContext.lineWidth = active ? 11 : 6;
    viewCubeContext.beginPath();
    viewCubeContext.moveTo(...edge.points[0]); viewCubeContext.lineTo(...edge.points[1]); viewCubeContext.stroke();
  }
  for (const corner of cornerRegions.filter((item) => item.depth > -.2)) {
    const active = hoveredViewCubeRegion?.id === corner.id;
    viewCubeContext.fillStyle = active ? "#fff" : "#a7a7a7";
    viewCubeContext.strokeStyle = "#303030"; viewCubeContext.lineWidth = 2;
    viewCubeContext.beginPath(); viewCubeContext.arc(corner.point[0], corner.point[1], active ? 10 : 7, 0, Math.PI * 2);
    viewCubeContext.fill(); viewCubeContext.stroke();
  }
  const hoveredCorner = hoveredViewCubeRegion?.type === "corner" && cornerRegions.find((item) => item.id === hoveredViewCubeRegion.id);
  if (hoveredCorner) {
    viewCubeContext.fillStyle = "#fff"; viewCubeContext.beginPath();
    viewCubeContext.arc(hoveredCorner.point[0], hoveredCorner.point[1], 8, 0, Math.PI * 2); viewCubeContext.fill();
  }
  const rollRegions = [
    { type: "roll", id: "roll-left", point: [22, centerY], angle: Math.PI / 12, label: "↶" },
    { type: "roll", id: "roll-right", point: [width - 22, centerY], angle: -Math.PI / 12, label: "↷" },
  ];
  for (const roll of rollRegions) {
    const active = hoveredViewCubeRegion?.id === roll.id;
    viewCubeContext.fillStyle = active ? "#fff" : "#bdbdbd";
    viewCubeContext.font = `${active ? 34 : 29}px system-ui`;
    viewCubeContext.textAlign = "center"; viewCubeContext.textBaseline = "middle";
    viewCubeContext.fillText(roll.label, roll.point[0], roll.point[1]);
  }
  viewCubeContext.fillStyle = "rgba(235,235,235,.72)";
  viewCubeContext.font = "600 13px system-ui";
  viewCubeContext.fillText("N", centerX, 12);
  viewCubeRegions = [...faceRegions, ...edgeRegions, ...cornerRegions, ...rollRegions];
}

function viewCubePointer(event) {
  const rect = viewCubeCanvas.getBoundingClientRect();
  return [
    (event.clientX - rect.left) * viewCubeCanvas.width / rect.width,
    (event.clientY - rect.top) * viewCubeCanvas.height / rect.height,
  ];
}

viewCubeCanvas.addEventListener("pointermove", (event) => {
  hoveredViewCubeRegion = viewCubeRegionAt(viewCubePointer(event));
  viewCubeCanvas.classList.toggle("hovering", Boolean(hoveredViewCubeRegion));
});
viewCubeCanvas.addEventListener("pointerleave", () => { hoveredViewCubeRegion = null; });
viewCubeCanvas.addEventListener("pointerdown", (event) => {
  viewCubeDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  viewCubeCanvas.setPointerCapture(event.pointerId);
});
viewCubeCanvas.addEventListener("pointermove", (event) => {
  if (!viewCubeDrag || viewCubeDrag.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - viewCubeDrag.x; const deltaY = event.clientY - viewCubeDrag.y;
  if (Math.hypot(deltaX, deltaY) > 1) {
    viewCubeDrag.moved = true;
    orbitFromViewCube(deltaX, deltaY);
    viewCubeDrag.x = event.clientX; viewCubeDrag.y = event.clientY;
  }
});
viewCubeCanvas.addEventListener("pointerup", (event) => {
  if (viewCubeDrag?.pointerId === event.pointerId) viewCubeCanvas.releasePointerCapture(event.pointerId);
});
viewCubeCanvas.addEventListener("pointercancel", () => { viewCubeDrag = null; });
viewCubeCanvas.addEventListener("click", (event) => {
  const dragged = viewCubeDrag?.moved;
  viewCubeDrag = null;
  if (dragged) return;
  const region = viewCubeRegionAt(viewCubePointer(event));
  if (region?.type === "roll") rollCamera(region.angle);
  else if (region?.direction) setCameraDirection(new THREE.Vector3(...region.direction));
});

const scenePresets = {
  dark: "#0b1117",
  light: "#e8e8e8",
  studio: "#6d7278",
  technical: "#d9dcdf",
};
const scenePresetSettings = {
  dark: { background: scenePresets.dark, lighting: true, reflections: true, lightIntensity: .8, reflectionIntensity: .3, darkLift: .16 },
  light: { background: scenePresets.light, lighting: true, reflections: true, lightIntensity: .95, reflectionIntensity: .18, darkLift: .18 },
  studio: { background: scenePresets.studio, lighting: true, reflections: true, lightIntensity: .9, reflectionIntensity: .22, darkLift: .24 },
  technical: { background: scenePresets.technical, lighting: true, reflections: false, lightIntensity: 1.05, reflectionIntensity: 0, darkLift: .32 },
};
const defaultSceneAppearance = Object.freeze({
  preset: "studio", ...scenePresetSettings.studio, grid: true, axes: true,
});
let sceneAppearance = { ...defaultSceneAppearance };
let sceneAppearanceBeforeDialog = null;

function sceneLevel(value, fallback, maximum = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? THREE.MathUtils.clamp(number, 0, maximum) : fallback;
}

function applySceneAppearance(settings, persist = true) {
  const background = /^#[0-9a-f]{6}$/i.test(settings.background || "")
    ? settings.background.toLowerCase() : defaultSceneAppearance.background;
  sceneAppearance = {
    preset: Object.hasOwn(scenePresets, settings.preset) ? settings.preset : "custom",
    background,
    grid: settings.grid !== false,
    axes: settings.axes !== false,
    lighting: settings.lighting !== false,
    reflections: settings.reflections !== false,
    lightIntensity: sceneLevel(settings.lightIntensity, defaultSceneAppearance.lightIntensity),
    reflectionIntensity: sceneLevel(settings.reflectionIntensity, defaultSceneAppearance.reflectionIntensity),
    darkLift: sceneLevel(settings.darkLift, defaultSceneAppearance.darkLift, .6),
  };
  scene.background.set(background);
  scene.fog.color.set(background);
  scene.environment = sceneAppearance.reflections ? environmentTexture : null;
  hemisphereLight.visible = sceneAppearance.lighting;
  keyLight.visible = sceneAppearance.lighting;
  fillLight.visible = sceneAppearance.lighting;
  hemisphereLight.intensity = lightLevels.hemisphere * sceneAppearance.lightIntensity;
  keyLight.intensity = lightLevels.key * sceneAppearance.lightIntensity;
  fillLight.intensity = lightLevels.fill * sceneAppearance.lightIntensity;
  scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.isMeshStandardMaterial) continue;
      if (material.userData.sourceColor) {
        material.color.copy(visualColor({
          color: material.userData.sourceColor,
          appearance: material.userData.sourceAppearance,
        }));
      }
      material.emissive.copy(sceneAppearance.lighting ? new THREE.Color(0) : material.color);
      material.emissiveIntensity = sceneAppearance.lighting ? 0 : 1;
      material.envMapIntensity = sceneAppearance.reflectionIntensity;
      material.needsUpdate = true;
    }
  });
  grid.visible = sceneAppearance.grid;
  axes.visible = sceneAppearance.axes;
  const color = new THREE.Color(background);
  const luminance = color.r * .2126 + color.g * .7152 + color.b * .0722;
  grid.material.color.set(luminance > .48 ? 0x444444 : 0xffffff);
  grid.material.opacity = luminance > .48 ? .42 : 1;
  grid.material.transparent = luminance > .48;
  grid.material.needsUpdate = true;
  if (persist) {
    try { localStorage.setItem("rc-car-scene-appearance", JSON.stringify(sceneAppearance)); }
    catch { /* Scene settings still apply for this session. */ }
  }
}

try {
  const savedSceneAppearance = JSON.parse(localStorage.getItem("rc-car-scene-appearance") || "null");
  if (savedSceneAppearance) applySceneAppearance(savedSceneAppearance, false);
} catch { /* Keep the default scene appearance. */ }

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const loader = new STLLoader();
const meshes = new Map();
const thumbnails = new Map();
const thumbnailTasks = new Map();
const ghosts = [];
const holeMarkers = [];
let state = null;
let bearingCatalog = {};
let rcCatalog = [];
let selectedRcCatalogId = null;
const rcCatalogThumbnails = new Map();
let selectedId = null;
let proposal = null;
let dragStartTransform = null;
let toastTimer = null;
let mateMode = false;
let magnetEnabled = false;
let sourceHoleRef = null;
let fastenerTargetRefs = [];
let pendingMate = null;
let directDrag = null;
let transformSnapCandidate = null;
let applyingTransformSnap = false;
let lastSnapMate = null;
let patternMode = false;
let patternSelections = [];
let throughMode = false;
let throughSelections = [];
let turnbuckleMode = false;
let turnbuckleSelections = [];
const snapFocusedComponentIds = new Set();
let historyBusy = false;
let snapRotationBusy = false;
let snapRotationTotal = 0;
let snapOffsetTotal = 0;
let quickRotateAxis = "z";
let quickRotateBusy = false;
let planeMateMode = "center";
let draggedComponentId = null;
let componentPresenceFilter = "all";
let pendingProject = null;
let positionCommitTimer = null;
const collapsedGroups = new Set();

function renderLocaleOptions() {
  const select = $("#localeSelect");
  select.replaceChildren();
  for (const item of availableLocales()) select.add(new Option(item.name, item.locale));
  select.value = currentLocale();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || t("http.error", { status: response.status }));
  return payload;
}

function toast(message, type = "info") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible ${type === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3200);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function setStatus(message) {
  $("#statusText").textContent = message;
}

function component(id) {
  return state.components.find((item) => item.id === id);
}

function jointForComponent(id) {
  return state?.joints?.find((joint) => {
    const source = Array.isArray(joint.source) ? joint.source[0] : joint.source;
    const target = Array.isArray(joint.target) ? joint.target[0] : joint.target;
    return source?.componentId === id || (joint.type === "rigid" && target?.componentId === id);
  }) || null;
}

function relationComponentId(value) {
  const ref = Array.isArray(value) ? value[0] : value;
  return ref?.componentId || null;
}

function rigidLinkedComponentIds(startId) {
  const found = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    for (const joint of state?.joints || []) {
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

function previewRigidLinks(movedId, beforeTransform) {
  const movedMesh = meshes.get(movedId);
  const linkedIds = rigidLinkedComponentIds(movedId);
  if (!movedMesh || linkedIds.size < 2) return;
  const oldPosition = new THREE.Vector3().fromArray(beforeTransform.positionMm);
  const oldQuaternion = new THREE.Quaternion().fromArray(beforeTransform.quaternionXyzw);
  const deltaRotation = movedMesh.quaternion.clone().multiply(oldQuaternion.invert()).normalize();
  for (const linkedId of linkedIds) {
    if (linkedId === movedId) continue;
    const linkedItem = component(linkedId);
    const linkedMesh = meshes.get(linkedId);
    if (!linkedItem || !linkedMesh) continue;
    linkedMesh.position.fromArray(linkedItem.transform.positionMm)
      .sub(oldPosition).applyQuaternion(deltaRotation).add(movedMesh.position);
    linkedMesh.quaternion.fromArray(linkedItem.transform.quaternionXyzw)
      .premultiply(deltaRotation).normalize();
    linkedMesh.updateMatrixWorld();
  }
}

function snapWorldAxis(ref) {
  if (Array.isArray(ref)) ref = ref[0];
  const item = snapItem(ref);
  const mesh = meshes.get(ref?.componentId);
  if (!item || !mesh) return new THREE.Vector3(0, 0, 1);
  const local = ["plane", "midplane"].includes(ref.interfaceType)
    ? item.localNormal
    : ref.interfaceType === "edge" ? item.localDirection : item.localAxis || [0, 0, 1];
  return new THREE.Vector3().fromArray(local).applyQuaternion(mesh.quaternion).normalize();
}

function holesFor(item) {
  return item?.interfaces?.holes || [];
}

function holeFor(ref) {
  return holesFor(component(ref.componentId)).find((hole) => hole.id === (ref.holeId || ref.interfaceId));
}

function snapItem(ref) {
  const collections = {
    hole: "holes", plane: "planes", shaft: "shafts", seat: "seats", edge: "edges", point: "points",
    center: "centers", midplane: "midplanes",
  };
  return component(ref.componentId)?.interfaces?.[collections[ref.interfaceType]]
    ?.find((item) => item.id === ref.interfaceId);
}

function snapRefsFor(item) {
  const refs = [];
  for (const hole of item.interfaces?.holes || []) for (const openingSide of [-1, 1]) {
    refs.push({ componentId: item.id, interfaceType: "hole", interfaceId: hole.id, openingSide });
  }
  for (const plane of item.interfaces?.planes || []) {
    refs.push({ componentId: item.id, interfaceType: "plane", interfaceId: plane.id });
  }
  for (const shaft of item.interfaces?.shafts || []) for (const endpointSide of [-1, 1]) {
    refs.push({ componentId: item.id, interfaceType: "shaft", interfaceId: shaft.id, endpointSide });
  }
  for (const seat of item.interfaces?.seats || []) {
    refs.push({ componentId: item.id, interfaceType: "seat", interfaceId: seat.id });
  }
  for (const edge of item.interfaces?.edges || []) {
    refs.push({ componentId: item.id, interfaceType: "edge", interfaceId: edge.id });
  }
  for (const point of item.interfaces?.points || []) {
    refs.push({ componentId: item.id, interfaceType: "point", interfaceId: point.id });
  }
  for (const center of item.interfaces?.centers || []) {
    refs.push({ componentId: item.id, interfaceType: "center", interfaceId: center.id });
  }
  for (const midplane of item.interfaces?.midplanes || []) {
    refs.push({ componentId: item.id, interfaceType: "midplane", interfaceId: midplane.id });
  }
  return refs;
}

function snapPairCompatible(first, second) {
  const pair = [first.interfaceType, second.interfaceType].sort().join("-");
  return [
    "center-center", "center-edge", "center-midplane", "center-plane", "center-point",
    "edge-edge", "edge-point", "hole-hole", "hole-shaft", "midplane-midplane",
    "midplane-plane", "midplane-point", "midplane-shaft", "plane-plane", "plane-point",
    "hole-seat", "plane-shaft", "point-point", "seat-seat", "seat-shaft", "shaft-shaft",
  ].includes(pair);
}

function snapFamily(ref) {
  if (["midplane", "plane"].includes(ref.interfaceType)) return "plane";
  if (["center", "point"].includes(ref.interfaceType)) return "point";
  return ref.interfaceType;
}

function snapRefPassesActiveFilter(ref) {
  const filter = $("#snapFilter").value;
  if (filter === "shaft") return ["shaft", "hole", "seat"].includes(snapFamily(ref));
  return filter === "all" || filter === snapFamily(ref);
}

function compatibleHoles(first, second) {
  return Boolean(first && second);
}

function holeWorldData(ref) {
  const item = component(ref.componentId);
  const hole = holeFor(ref);
  const mesh = meshes.get(ref.componentId);
  if (!item || !hole || !mesh) return null;
  const center = new THREE.Vector3().fromArray(hole.localCenterMm).applyQuaternion(mesh.quaternion).add(mesh.position);
  const axis = new THREE.Vector3().fromArray(hole.localAxis).applyQuaternion(mesh.quaternion).normalize();
  const halfDepth = hole.depthMm * 0.5;
  return {
    center,
    axis,
    openings: [center.clone().addScaledVector(axis, -halfDepth), center.clone().addScaledVector(axis, halfDepth)],
  };
}

let carbonTexture = null;

function carbonFiberTexture() {
  if (carbonTexture) return carbonTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  context.fillStyle = "#686868";
  context.fillRect(0, 0, 64, 64);
  for (let y = -16; y < 80; y += 16) {
    for (let x = -16; x < 80; x += 16) {
      context.fillStyle = ((x + y) / 16) % 2 ? "#999" : "#424242";
      context.save();
      context.translate(x + 8, y + 8);
      context.rotate(Math.PI / 4);
      context.fillRect(-10, -3, 20, 6);
      context.restore();
    }
  }
  carbonTexture = new THREE.CanvasTexture(canvas);
  carbonTexture.wrapS = carbonTexture.wrapT = THREE.RepeatWrapping;
  carbonTexture.repeat.set(5, 5);
  carbonTexture.colorSpace = THREE.SRGBColorSpace;
  return carbonTexture;
}

function materialProfile(item) {
  const profiles = {
    aluminum: { metalness: .82, roughness: .3 },
    steel: { metalness: .94, roughness: .22 },
    carbon: { metalness: .38, roughness: .3, map: carbonFiberTexture(), roughnessMap: carbonFiberTexture() },
    bronze: { metalness: .8, roughness: .32 },
    copper: { metalness: .9, roughness: .24 },
    "plastic-matte": { metalness: .02, roughness: .76 },
    "plastic-gloss": { metalness: .02, roughness: .18 },
    rubber: { metalness: 0, roughness: .94 },
  };
  return profiles[item.appearance] || {
    roughness: item.kind === "fastener" ? .32 : .58,
    metalness: item.kind === "fastener" ? .78 : item.status.includes("reference") ? .35 : .12,
  };
}

function visualColor(item) {
  const color = new THREE.Color(item.color);
  if (item.appearance === "carbon" && color.r + color.g + color.b < .08) color.set("#202428");
  const luminance = color.r * .2126 + color.g * .7152 + color.b * .0722;
  const darkness = 1 - THREE.MathUtils.smoothstep(luminance, .08, .52);
  color.lerp(new THREE.Color(1, 1, 1), sceneAppearance.darkLift * darkness);
  return color;
}

function effectiveOpacity(item) {
  if (Number.isFinite(item.opacity)) return THREE.MathUtils.clamp(item.opacity, .1, 1);
  return item.status.includes("reference") ? .72 : 1;
}

function materialFor(item) {
  const opacity = effectiveOpacity(item);
  const color = visualColor(item);
  const material = new THREE.MeshStandardMaterial({
    color,
    ...materialProfile(item),
    vertexColors: item.kind === "bearing" || item.kind === "fastener",
    emissive: sceneAppearance.lighting ? 0x000000 : color,
    emissiveIntensity: sceneAppearance.lighting ? 0 : 1,
    envMapIntensity: sceneAppearance.reflectionIntensity,
    transparent: opacity < .999,
    opacity,
    depthWrite: opacity >= .999,
  });
  material.userData.sourceColor = item.color;
  material.userData.sourceAppearance = item.appearance || "default";
  return material;
}

const FASTENER_DIMENSIONS = Object.freeze({
  ISO4762: { 2: [3.8, 2, 1.5, 1], 2.5: [4.5, 2.5, 2, 1.1], 3: [5.5, 3, 2.5, 1.3], 4: [7, 4, 3, 2], 5: [8.5, 5, 4, 2.5], 6: [10, 6, 5, 3], 8: [13, 8, 6, 4] },
  ISO7380: { 2: [3.5, 1.3, 1.3, .8], 2.5: [4.7, 1.5, 1.5, .9], 3: [5.7, 1.65, 2, 1.04], 4: [7.6, 2.2, 2.5, 1.3], 5: [9.5, 2.75, 3, 1.56], 6: [10.5, 3.3, 4, 1.9], 8: [14, 4.4, 5, 2.6] },
  ISO10642: { 2: [4, 1.2, 1.3, .65], 2.5: [5, 1.5, 1.5, .8], 3: [6, 1.7, 2, .95], 4: [8, 2.3, 2.5, 1.45], 5: [10, 2.8, 3, 1.75], 6: [12, 3.3, 4, 2.1], 8: [16, 4.4, 5, 2.8] },
  ISO4017: { 2: [4.62, 1.4, 0, 0], 2.5: [5.77, 1.7, 0, 0], 3: [6.35, 2, 0, 0], 4: [8.08, 2.8, 0, 0], 5: [9.24, 3.5, 0, 0], 6: [11.55, 4, 0, 0], 8: [15.01, 5.3, 0, 0] },
});

function fastenerGeometry(spec) {
  const diameter = Number(spec.diameterMm);
  const length = Number(spec.lengthMm);
  const headRadius = Number(spec.headDiameterMm) / 2;
  const headHeight = Number(spec.headHeightMm);
  const shaftRadius = diameter / 2;
  const tipBevel = Math.min(0.35, length * 0.08);
  const shaftProfile = [
    new THREE.Vector2(0, -length),
    new THREE.Vector2(shaftRadius * 0.78, -length),
    new THREE.Vector2(shaftRadius, -length + tipBevel),
  ];
  const buttonDome = Array.from({ length: 11 }, (_, index) => {
    const angle = index / 10 * Math.PI / 2;
    return new THREE.Vector2(headRadius * Math.cos(angle), headHeight * Math.sin(angle));
  });
  const profile = spec.standard === "ISO10642"
    ? [
      ...shaftProfile,
      new THREE.Vector2(shaftRadius, -headHeight),
      new THREE.Vector2(headRadius, 0),
      new THREE.Vector2(0, 0),
    ]
    : spec.standard === "ISO7380"
      ? [...shaftProfile, new THREE.Vector2(shaftRadius, 0), ...buttonDome]
    : spec.standard === "ISO4017"
      ? [...shaftProfile, new THREE.Vector2(shaftRadius, 0), new THREE.Vector2(0, 0)]
    : [
      ...shaftProfile,
      new THREE.Vector2(shaftRadius, 0),
      new THREE.Vector2(headRadius, 0),
      new THREE.Vector2(headRadius, Math.max(0, headHeight - 0.25)),
      new THREE.Vector2(Math.max(0, headRadius - 0.25), headHeight),
      new THREE.Vector2(0, headHeight),
    ];
  const lathe = new THREE.LatheGeometry(profile, 24);
  const geometry = lathe.index ? lathe.toNonIndexed() : lathe;
  if (geometry !== lathe) lathe.dispose();
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  const bodyColors = new Float32Array(geometry.getAttribute("position").count * 3).fill(1);
  geometry.setAttribute("color", new THREE.BufferAttribute(bodyColors, 3));

  if (spec.standard === "ISO4017") {
    const headIndexed = new THREE.CylinderGeometry(headRadius, headRadius, headHeight, 6);
    const head = headIndexed.toNonIndexed();
    headIndexed.dispose();
    head.rotateX(Math.PI / 2);
    head.translate(0, 0, headHeight / 2);
    const headColors = new Float32Array(head.getAttribute("position").count * 3).fill(1);
    head.setAttribute("color", new THREE.BufferAttribute(headColors, 3));
    const mergedBolt = mergeGeometries([geometry, head], false);
    geometry.dispose();
    head.dispose();
    mergedBolt.computeVertexNormals();
    return mergedBolt;
  }

  // A shallow dark hexagonal insert makes the drive recess unambiguous in the
  // WebGL view. The exported CAD solid below contains the actual cut cavity.
  const fallbackAcrossFlats = ({ 3: 2.5, 4: 3, 5: 4 })[diameter] || diameter * .75;
  const acrossFlats = Number(spec.socketAcrossFlatsMm || fallbackAcrossFlats);
  const socketRadius = acrossFlats / Math.sqrt(3);
  const topZ = spec.standard === "ISO10642" ? 0 : headHeight;
  const socketMarkerIndexed = new THREE.CylinderGeometry(socketRadius, socketRadius, .06, 6, 1, false);
  const socketMarker = socketMarkerIndexed.toNonIndexed();
  socketMarkerIndexed.dispose();
  socketMarker.rotateX(Math.PI / 2);
  socketMarker.translate(0, 0, topZ + .015);
  const socketColor = new THREE.Color(.08, .09, .1);
  const socketColors = new Float32Array(socketMarker.getAttribute("position").count * 3);
  for (let index = 0; index < socketMarker.getAttribute("position").count; index += 1) {
    socketColors[index * 3] = socketColor.r;
    socketColors[index * 3 + 1] = socketColor.g;
    socketColors[index * 3 + 2] = socketColor.b;
  }
  socketMarker.setAttribute("color", new THREE.BufferAttribute(socketColors, 3));
  const merged = mergeGeometries([geometry, socketMarker], false);
  geometry.dispose();
  socketMarker.dispose();
  merged.computeVertexNormals();
  return merged;
}

function bearingRelativeColor(target, base) {
  const targetColor = new THREE.Color(target);
  const baseColor = new THREE.Color(base);
  return new THREE.Color(
    THREE.MathUtils.clamp(targetColor.r / Math.max(baseColor.r, .01), 0, 1),
    THREE.MathUtils.clamp(targetColor.g / Math.max(baseColor.g, .01), 0, 1),
    THREE.MathUtils.clamp(targetColor.b / Math.max(baseColor.b, .01), 0, 1),
  );
}

function colorBearingGeometry(geometry, spec, raceColor) {
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const inner = Number(spec.innerDiameterMm) / 2;
  const outer = Number(spec.outerDiameterMm) / 2;
  const half = Number(spec.widthMm) / 2;
  const raceWidth = Math.min(Math.max((outer - inner) * .24, .18), (outer - inner) * .42);
  const closureInner = inner + raceWidth;
  const closureOuter = outer - raceWidth;
  const faceTolerance = Math.max(.04, Number(spec.widthMm) * .025);
  const closure = spec.closure || "zz";
  const closureColor = bearingRelativeColor(
    spec.sealColor || ({ open: "#c69b46", zz: "#c8cdd1", "2rs": "#202326" })[closure],
    raceColor,
  );
  const openBallColor = bearingRelativeColor("#dce1e4", raceColor);
  const raceVertexColor = new THREE.Color(1, 1, 1);
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index); const y = positions.getY(index); const z = positions.getZ(index);
    const radius = Math.hypot(x, y);
    const closureFace = Math.abs(Math.abs(z) - half) <= faceTolerance
      && radius >= closureInner - .02 && radius <= closureOuter + .02;
    let color = raceVertexColor;
    if (closureFace) {
      if (closure === "open") {
        const sector = Math.floor(((Math.atan2(y, x) + Math.PI) / (Math.PI * 2)) * 20);
        color = sector % 2 ? closureColor : openBallColor;
      } else color = closureColor;
    }
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.getAttribute("color").needsUpdate = true;
}

function bearingGeometry(spec, raceColor = "#9da3a6") {
  const inner = Number(spec.innerDiameterMm) / 2;
  const outer = Number(spec.outerDiameterMm) / 2;
  const half = Number(spec.widthMm) / 2;
  const bevel = Math.min(.35, (outer - inner) * .16, half * .2);
  const raceWidth = Math.min(Math.max((outer - inner) * .24, .18), (outer - inner) * .42);
  const profile = [
    new THREE.Vector2(inner + bevel, -half), new THREE.Vector2(inner + raceWidth, -half),
    new THREE.Vector2(outer - raceWidth, -half), new THREE.Vector2(outer - bevel, -half),
    new THREE.Vector2(outer, -half + bevel), new THREE.Vector2(outer, half - bevel),
    new THREE.Vector2(outer - bevel, half), new THREE.Vector2(outer - raceWidth, half),
    new THREE.Vector2(inner + raceWidth, half), new THREE.Vector2(inner + bevel, half),
    new THREE.Vector2(inner, half - bevel), new THREE.Vector2(inner, -half + bevel),
    new THREE.Vector2(inner + bevel, -half),
  ];
  const lathe = new THREE.LatheGeometry(profile, 64);
  const geometry = lathe.index ? lathe.toNonIndexed() : lathe;
  if (geometry !== lathe) lathe.dispose();
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  colorBearingGeometry(geometry, spec, raceColor);
  return geometry;
}

function mergeOwnedGeometries(parts) {
  const normalized = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const merged = mergeGeometries(normalized, false);
  for (const part of parts) part.dispose();
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== parts[index]) normalized[index].dispose();
  }
  if (!merged) throw new Error("Unable to merge procedural component geometry");
  return merged;
}

function catalogGeometry(spec) {
  const shape = spec.shape;
  if (shape.type === "box") return new THREE.BoxGeometry(shape.widthMm, shape.depthMm, shape.heightMm);
  if (shape.type === "motor") {
    const bodyRadius = shape.diameterMm / 2;
    const body = new THREE.CylinderGeometry(bodyRadius * .96, bodyRadius * .96, shape.bodyLengthMm - 4, 32);
    body.rotateX(Math.PI / 2);
    const frontBell = new THREE.CylinderGeometry(bodyRadius, bodyRadius, 3, 32);
    frontBell.rotateX(Math.PI / 2);
    frontBell.translate(0, 0, shape.bodyLengthMm / 2 - 1.5);
    const rearBell = new THREE.CylinderGeometry(bodyRadius, bodyRadius, 3, 32);
    rearBell.rotateX(Math.PI / 2);
    rearBell.translate(0, 0, -shape.bodyLengthMm / 2 + 1.5);
    const shaft = new THREE.CylinderGeometry(shape.shaftDiameterMm / 2, shape.shaftDiameterMm / 2, shape.shaftLengthMm, 20);
    shaft.rotateX(Math.PI / 2);
    shaft.translate(0, 0, shape.bodyLengthMm / 2 + shape.shaftLengthMm / 2);
    const parts = [body, frontBell, rearBell, shaft];
    for (const offset of [-.28, -.14, 0, .14, .28]) {
      const ring = new THREE.TorusGeometry(bodyRadius * .965, Math.max(.35, shape.diameterMm * .012), 6, 32);
      ring.translate(0, 0, offset * shape.bodyLengthMm);
      parts.push(ring);
    }
    return mergeOwnedGeometries(parts);
  }
  if (shape.type === "servo") {
    const body = new THREE.BoxGeometry(shape.widthMm, shape.depthMm, shape.heightMm);
    const flangeShape = new THREE.Shape();
    flangeShape.moveTo(-shape.mountWidthMm / 2, -shape.mountDepthMm / 2);
    flangeShape.lineTo(shape.mountWidthMm / 2, -shape.mountDepthMm / 2);
    flangeShape.lineTo(shape.mountWidthMm / 2, shape.mountDepthMm / 2);
    flangeShape.lineTo(-shape.mountWidthMm / 2, shape.mountDepthMm / 2);
    flangeShape.closePath();
    for (const xSign of [-1, 1]) for (const ySign of [-1, 1]) {
      const hole = new THREE.Path();
      hole.absarc(
        xSign * shape.mountHoleSpacingXmm / 2,
        ySign * shape.mountHoleSpacingYmm / 2,
        shape.mountHoleDiameterMm / 2,
        0, Math.PI * 2, true,
      );
      flangeShape.holes.push(hole);
    }
    const flange = new THREE.ExtrudeGeometry(flangeShape, {
      depth: shape.mountTabThicknessMm, bevelEnabled: false, curveSegments: 16,
    });
    flange.translate(0, 0, shape.mountTabCenterZMm - shape.mountTabThicknessMm / 2);
    const spline = new THREE.CylinderGeometry(shape.splineDiameterMm / 2, shape.splineDiameterMm / 2, shape.splineHeightMm, 20);
    spline.rotateX(Math.PI / 2);
    spline.translate(shape.widthMm * .28, 0, shape.heightMm / 2 + shape.splineHeightMm / 2);
    const splineBoss = new THREE.CylinderGeometry(shape.splineDiameterMm, shape.splineDiameterMm, 2, 24);
    splineBoss.rotateX(Math.PI / 2);
    splineBoss.translate(shape.widthMm * .28, 0, shape.heightMm / 2 + 1);
    return mergeOwnedGeometries([body, flange, splineBoss, spline]);
  }
  if (shape.type === "esc") {
    const body = new THREE.BoxGeometry(shape.widthMm, shape.depthMm, shape.heightMm);
    const fan = new THREE.CylinderGeometry(shape.fanDiameterMm / 2, shape.fanDiameterMm / 2, 2.5, 28);
    fan.rotateX(Math.PI / 2);
    fan.translate(0, 0, shape.heightMm / 2 + 1.25);
    const hub = new THREE.CylinderGeometry(shape.fanDiameterMm * .12, shape.fanDiameterMm * .12, 3.2, 20);
    hub.rotateX(Math.PI / 2);
    hub.translate(0, 0, shape.heightMm / 2 + 1.6);
    return mergeOwnedGeometries([body, fan, hub]);
  }
  throw new Error(`Unsupported catalog geometry: ${shape.type}`);
}

function turnbuckleGeometry(spec) {
  const rodLength = Math.max(1, spec.centerDistanceMm - spec.endDiameterMm * .65);
  const rod = new THREE.CylinderGeometry(spec.rodDiameterMm / 2, spec.rodDiameterMm / 2, rodLength, 6);
  rod.rotateX(Math.PI / 2);
  const first = new THREE.SphereGeometry(spec.endDiameterMm / 2, 18, 12);
  first.translate(0, 0, -spec.centerDistanceMm / 2);
  const second = new THREE.SphereGeometry(spec.endDiameterMm / 2, 18, 12);
  second.translate(0, 0, spec.centerDistanceMm / 2);
  return mergeOwnedGeometries([rod, first, second]);
}

function proceduralGeometrySignature(item) {
  if (item.kind === "fastener") return `fastener:${JSON.stringify(item.fastener)}`;
  if (item.kind === "bearing") return `bearing:${JSON.stringify(item.bearing)}:${item.color}`;
  if (item.kind === "catalog") return `catalog:${JSON.stringify(item.catalog)}`;
  if (item.kind === "turnbuckle") return `turnbuckle:${JSON.stringify(item.turnbuckle)}`;
  return null;
}

function createComponentGeometry(item) {
  return item.kind === "fastener"
    ? fastenerGeometry(item.fastener)
    : item.kind === "bearing" ? bearingGeometry(item.bearing, item.color)
      : item.kind === "catalog" ? catalogGeometry(item.catalog)
        : item.kind === "turnbuckle" ? turnbuckleGeometry(item.turnbuckle) : null;
}

function prepareComponentGeometry(geometry) {
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  ensureProceduralUv(geometry);
  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  return geometry;
}

function ensureProceduralUv(geometry) {
  if (geometry.getAttribute("uv")) return;
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const uv = new Float32Array(positions.count * 2);
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index); const y = positions.getY(index); const z = positions.getZ(index);
    const nx = Math.abs(normals?.getX(index) || 0);
    const ny = Math.abs(normals?.getY(index) || 0);
    const nz = Math.abs(normals?.getZ(index) || 1);
    const [u, v] = nx >= ny && nx >= nz ? [y, z] : ny >= nz ? [x, z] : [x, y];
    uv[index * 2] = u / 12;
    uv[index * 2 + 1] = v / 12;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

async function loadComponent(item) {
  const geometry = createComponentGeometry(item) || await loader.loadAsync(item.meshUrl);
  // STL files exported by FreeCAD already contain facet normals. Rebuilding
  // them on the main browser thread was one of the largest startup costs.
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  ensureProceduralUv(geometry);
  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  const thumbnail = geometryThumbnail(geometry, item.color);
  thumbnails.set(item.id, thumbnail);
  const mesh = new THREE.Mesh(geometry, materialFor(item));
  mesh.name = item.id;
  mesh.userData.componentId = item.id;
  mesh.userData.displayColor = item.color;
  mesh.userData.displayAppearance = item.appearance || "default";
  mesh.userData.displayOpacity = effectiveOpacity(item);
  mesh.userData.geometrySignature = proceduralGeometrySignature(item);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  meshes.set(item.id, mesh);
  syncMesh(item);
  const preview = document.querySelector(`[data-thumbnail="${CSS.escape(item.id)}"]`);
  if (preview) preview.src = thumbnail;
}

async function ensureThumbnail(item) {
  if (thumbnails.has(item.id) || meshes.has(item.id)) return thumbnails.get(item.id);
  if (thumbnailTasks.has(item.id)) return thumbnailTasks.get(item.id);
  const task = (async () => {
    const geometry = createComponentGeometry(item) || await loader.loadAsync(item.meshUrl);
    const thumbnail = geometryThumbnail(geometry, item.color);
    geometry.dispose();
    thumbnails.set(item.id, thumbnail);
    return thumbnail;
  })().finally(() => thumbnailTasks.delete(item.id));
  thumbnailTasks.set(item.id, task);
  return task;
}

const previewObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    previewObserver.unobserve(entry.target);
    const item = state && component(entry.target.dataset.thumbnail);
    if (!item) continue;
    ensureThumbnail(item).then((thumbnail) => {
      if (entry.target.isConnected) entry.target.src = thumbnail;
    }).catch((error) => console.error(t("loading.failedPart", { id: item.id }), error));
  }
}, { root: $("#componentList"), rootMargin: "180px 0px" });

function geometryThumbnail(geometry, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 116;
  canvas.height = 84;
  const context = canvas.getContext("2d");
  const positions = geometry.getAttribute("position");
  const vertexColors = geometry.getAttribute("color");
  const triangleCount = Math.floor(positions.count / 3);
  const stride = Math.max(1, Math.ceil(triangleCount / 760));
  const triangles = [];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const project = (point) => {
    const { x, y, z } = point;
    const projected = [x - y * 0.72, -z + (x + y) * 0.24];
    minX = Math.min(minX, projected[0]); maxX = Math.max(maxX, projected[0]);
    minY = Math.min(minY, projected[1]); maxY = Math.max(maxY, projected[1]);
    return projected;
  };
  const lightDirection = new THREE.Vector3(-.35, -.45, .82).normalize();
  for (let triangle = 0; triangle < triangleCount; triangle += stride) {
    const base = triangle * 3;
    const points = [0, 1, 2].map((offset) => new THREE.Vector3(
      positions.getX(base + offset), positions.getY(base + offset), positions.getZ(base + offset),
    ));
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
    triangles.push({
      projected: points.map(project),
      depth: points.reduce((sum, point) => sum + point.x + point.y + point.z * .65, 0) / 3,
      shade: .48 + Math.abs(normal.dot(lightDirection)) * .52,
      vertexColor: vertexColors ? new THREE.Color(
        (vertexColors.getX(base) + vertexColors.getX(base + 1) + vertexColors.getX(base + 2)) / 3,
        (vertexColors.getY(base) + vertexColors.getY(base + 1) + vertexColors.getY(base + 2)) / 3,
        (vertexColors.getZ(base) + vertexColors.getZ(base + 1) + vertexColors.getZ(base + 2)) / 3,
      ) : null,
    });
  }
  triangles.sort((first, second) => first.depth - second.depth);
  const scale = Math.min(100 / Math.max(maxX - minX, 1), 68 / Math.max(maxY - minY, 1));
  const offsetX = (canvas.width - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = (canvas.height - (maxY - minY) * scale) / 2 - minY * scale;
  context.fillStyle = "#d7d9db";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#cdd0d2";
  for (let y = 0; y < canvas.height; y += 14) for (let x = 0; x < canvas.width; x += 14) {
    if ((x / 14 + y / 14) % 2 === 0) context.fillRect(x, y, 14, 14);
  }
  context.fillStyle = "rgba(0,0,0,.14)";
  context.beginPath();
  context.ellipse(canvas.width / 2, canvas.height - 8, canvas.width * .3, 4, 0, 0, Math.PI * 2);
  context.fill();
  const baseColor = new THREE.Color(color);
  context.lineWidth = .65;
  for (const triangle of triangles) {
    const shaded = baseColor.clone().multiply(triangle.vertexColor || new THREE.Color(1, 1, 1)).multiplyScalar(triangle.shade);
    const minimum = baseColor.r + baseColor.g + baseColor.b < .09 ? .055 : 0;
    shaded.r = Math.max(shaded.r, minimum); shaded.g = Math.max(shaded.g, minimum); shaded.b = Math.max(shaded.b, minimum);
    context.fillStyle = `#${shaded.getHexString()}`;
    context.strokeStyle = baseColor.r + baseColor.g + baseColor.b > 2.15 ? "rgba(35,35,35,.55)" : "rgba(0,0,0,.32)";
    context.beginPath();
    context.moveTo(triangle.projected[0][0] * scale + offsetX, triangle.projected[0][1] * scale + offsetY);
    context.lineTo(triangle.projected[1][0] * scale + offsetX, triangle.projected[1][1] * scale + offsetY);
    context.lineTo(triangle.projected[2][0] * scale + offsetX, triangle.projected[2][1] * scale + offsetY);
    context.closePath();
    context.fill();
    context.stroke();
  }
  return canvas.toDataURL("image/png");
}

function loadingPriority(item) {
  if (!item.visible) return 1_000_000 + item.triangles;
  if (item.locked) return -1_000_000;
  if (item.status === "exact-source-joint") return -500_000 + item.triangles;
  if (item.status.startsWith("provisional") || item.status.startsWith("user-guided")) {
    return -250_000 + item.triangles;
  }
  return item.triangles;
}

async function loadComponentsProgressively(items, concurrency = 8) {
  const queue = [...items].sort((a, b) => loadingPriority(a) - loadingPriority(b));
  let cursor = 0;
  let loaded = 0;
  let failed = 0;
  let sceneRevealed = false;

  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor];
      cursor += 1;
      try {
        await loadComponent(item);
        loaded += 1;
      } catch (error) {
        failed += 1;
        console.error(t("loading.failedPart", { id: item.id }), error);
      }
      $("#loadingProgress").textContent = `${loaded + failed} / ${items.length}`;

      // The chassis plus the first validated components are enough to start
      // navigating. Remaining meshes continue streaming in the background.
      if (!sceneRevealed && (meshes.has("chassis_4mm") && loaded >= 6)) {
        sceneRevealed = true;
        $("#loadingOverlay").classList.add("hidden");
        fitView();
        setStatus(t("loading.sceneReady", { loaded, total: items.length }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  if (!sceneRevealed) $("#loadingOverlay").classList.add("hidden");
  return { loaded, failed, sceneRevealed };
}

function syncMesh(item) {
  const mesh = meshes.get(item.id);
  if (!mesh) return;
  const geometrySignature = proceduralGeometrySignature(item);
  if (geometrySignature && mesh.userData.geometrySignature !== geometrySignature) {
    const geometry = prepareComponentGeometry(createComponentGeometry(item));
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.userData.geometrySignature = geometrySignature;
    const thumbnail = geometryThumbnail(geometry, item.color);
    thumbnails.set(item.id, thumbnail);
    const preview = document.querySelector(`[data-thumbnail="${CSS.escape(item.id)}"]`);
    if (preview) preview.src = thumbnail;
  }
  if (mesh.userData.displayColor !== item.color) {
    if (item.kind === "bearing") colorBearingGeometry(mesh.geometry, item.bearing, item.color);
    mesh.material.userData.sourceColor = item.color;
    mesh.material.color.copy(visualColor(item));
    if (!sceneAppearance.lighting) mesh.material.emissive.copy(mesh.material.color);
    mesh.userData.displayColor = item.color;
    const thumbnail = geometryThumbnail(mesh.geometry, item.color);
    thumbnails.set(item.id, thumbnail);
    const preview = document.querySelector(`[data-thumbnail="${CSS.escape(item.id)}"]`);
    if (preview) preview.src = thumbnail;
  }
  const appearance = item.appearance || "default";
  if (mesh.userData.displayAppearance !== appearance) {
    const profile = materialProfile(item);
    mesh.material.metalness = profile.metalness;
    mesh.material.roughness = profile.roughness;
    mesh.material.map = profile.map || null;
    mesh.material.roughnessMap = profile.roughnessMap || null;
    mesh.material.userData.sourceAppearance = appearance;
    mesh.material.color.copy(visualColor(item));
    mesh.material.needsUpdate = true;
    mesh.userData.displayAppearance = appearance;
  }
  const opacity = effectiveOpacity(item);
  if (mesh.userData.displayOpacity !== opacity) {
    mesh.material.opacity = opacity;
    mesh.material.transparent = opacity < .999;
    mesh.material.depthWrite = opacity >= .999;
    mesh.material.needsUpdate = true;
    mesh.userData.displayOpacity = opacity;
  }
  mesh.position.fromArray(item.transform.positionMm);
  mesh.quaternion.fromArray(item.transform.quaternionXyzw);
  mesh.visible = item.visible;
  mesh.updateMatrixWorld();
}

function syncAllMeshes() {
  for (const item of state.components) syncMesh(item);
  if (selectedId) selectComponent(selectedId, false);
  if (mateMode) renderMateMarkers();
}

async function reconcileMeshesWithState() {
  const componentIds = new Set(state.components.map((item) => item.id));
  for (const [id, mesh] of meshes) {
    if (componentIds.has(id)) continue;
    if (transform.object === mesh) transform.detach();
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    meshes.delete(id);
    thumbnails.delete(id);
  }
  if (selectedId && !componentIds.has(selectedId)) {
    selectedId = null;
    transform.detach();
    $("#selectedLabel").textContent = t("selection.noComponent");
    $("#selectedMeta").textContent = t("selection.help");
    $("#selectionSummary").textContent = t("selection.none");
    $("#transformEditor").classList.add("hidden");
    $("#revealComponent").classList.add("hidden");
  }
  const missing = state.components.filter((item) => item.visible && !meshes.has(item.id));
  await Promise.all(missing.map((item) => loadComponent(item)));
  syncAllMeshes();
}

function fitView(direction = new THREE.Vector3(1, -1, 0.7), up = null) {
  const box = new THREE.Box3();
  for (const mesh of meshes.values()) if (mesh.visible) box.expandByObject(mesh);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * .5, 1);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, .1));
  const limitingFov = Math.min(verticalFov, horizontalFov);
  const distance = radius / Math.sin(limitingFov / 2) * 1.08;
  const normalized = stableViewDirection(direction);
  camera.up.copy(up || stableViewUp());
  camera.position.copy(center).add(normalized.multiplyScalar(distance));
  camera.near = Math.max(0.1, distance / 1000);
  camera.far = Math.max(distance * 10, radius * 20);
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  camera.updateMatrixWorld();
  orbit.target.copy(center);
  orbit.update();
  viewCubeRenderKey = "";
}

function fitViewToWidth(direction) {
  const box = new THREE.Box3();
  for (const mesh of meshes.values()) if (mesh.visible) box.expandByObject(mesh);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const normalized = stableViewDirection(direction);
  const up = stableViewUp();
  const right = new THREE.Vector3().crossVectors(up, normalized).normalize();
  let halfWidth = 0;
  let halfDepth = 0;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) {
    for (const z of [box.min.z, box.max.z]) {
      const offset = new THREE.Vector3(x, y, z).sub(center);
      halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
      halfDepth = Math.max(halfDepth, Math.abs(offset.dot(normalized)));
    }
  }
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, .1));
  const distance = Math.max(halfWidth / Math.tan(horizontalFov / 2) * 1.04 + halfDepth, 1);
  camera.up.copy(up);
  camera.position.copy(center).addScaledVector(normalized, distance);
  camera.near = Math.max(.1, (distance - halfDepth) / 100);
  camera.far = Math.max(distance * 10, (distance + halfDepth) * 2);
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  camera.updateMatrixWorld();
  orbit.target.copy(center);
  orbit.update();
  viewCubeRenderKey = "";
}

function componentStlFilename(item) {
  if (item.kind === "fastener") {
    return `${item.fastener.standard} · M${item.fastener.diameterMm}×${item.fastener.lengthMm} · generated`;
  }
  if (item.kind === "bearing") {
    return `${item.bearing.series} ${String(item.bearing.closure || "zz").toUpperCase()} · ${item.bearing.innerDiameterMm}×${item.bearing.outerDiameterMm}×${item.bearing.widthMm} mm · generated`;
  }
  if (item.kind === "catalog") return `${item.catalog.id} · ${item.catalog.scale} · generated`;
  if (item.kind === "turnbuckle") return `Turnbuckle · ${item.turnbuckle.centerDistanceMm.toFixed(1)} mm · generated`;
  const filename = String(item.meshUrl || "").split("/").pop() || "";
  try { return decodeURIComponent(filename); } catch { return filename; }
}

function clearGroupDropTargets() {
  for (const section of document.querySelectorAll(".component-group.drop-target")) {
    section.classList.remove("drop-target");
  }
}

function componentListRow(item) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `component-item ${item.visible ? "in-assembly" : "removed"} ${item.id === selectedId ? "selected" : ""} ${snapFocusedComponentIds.has(item.id) ? "snap-focused" : ""}`;
    row.style.setProperty("--part-color", item.color);
    row.dataset.id = item.id;
    row.draggable = true;
    const stlFilename = componentStlFilename(item);
    row.innerHTML = `
      <span class="component-color" style="background:${item.color}"></span>
      <img class="part-preview" data-thumbnail="${escapeHtml(item.id)}" alt="" src="${thumbnails.get(item.id) || ""}">
      <span class="component-copy">
        <span class="component-label">${escapeHtml(item.label)}</span>
        <span class="component-status"><b>${escapeHtml(t(item.visible ? "part.inAssembly" : "part.removed"))}</b> · ${escapeHtml(item.status)}</span>
        <span class="component-filename" title="${escapeHtml(stlFilename)}">${escapeHtml(stlFilename)}</span>
      </span>
      <span class="visibility-toggle ${item.visible ? "" : "off"}" title="${escapeHtml(t(item.visible ? "part.removeTitle" : "part.addTitle"))}">${flatIcon(item.visible ? "check" : "plus")}</span>`;
    row.addEventListener("click", async (event) => {
      if (event.target.closest(".visibility-toggle")) {
        event.stopPropagation();
        toggleVisibility(item.id).catch((error) => toast(error.message, "error"));
      } else {
        if (!meshes.has(item.id)) {
          setStatus(t("loading.selectedPart", { name: item.label }));
          try { await loadComponent(item); }
          catch (error) { toast(t("loading.failedPart", { id: item.id }), "error"); return; }
        }
        if (mateMode) setSnapComponentFocus(item.id, event.shiftKey);
        selectComponent(item.id);
        if (!mateMode) setTransformMode("translate");
      }
    });
    row.addEventListener("dragstart", (event) => {
      draggedComponentId = item.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
    });
    row.addEventListener("dragend", () => {
      draggedComponentId = null;
      row.classList.remove("dragging");
      clearGroupDropTargets();
    });
    return row;
}

function renderComponentList(filter = "") {
  const needle = filter.trim().toLowerCase();
  const list = $("#componentList");
  list.replaceChildren();
  previewObserver.disconnect();
  const assembledCount = state.components.filter((item) => item.visible).length;
  $("#componentCount").textContent = `${assembledCount}/${state.components.length}`;
  $("#filterAllCount").textContent = state.components.length;
  $("#filterPlacedCount").textContent = assembledCount;
  $("#filterUnplacedCount").textContent = state.components.length - assembledCount;
  const groups = [...(state.groups || []), {
    id: null,
    name: state.workspace?.ungroupedName || t("groups.ungrouped"),
    system: true,
  }];
  for (const group of groups) {
    const groupMatches = needle && group.name.toLowerCase().includes(needle);
    const items = state.components.filter((item) => {
      const belongs = (item.groupId || null) === group.id;
      const presenceMatches = componentPresenceFilter === "all"
        || (componentPresenceFilter === "placed" ? item.visible : !item.visible);
      const searchable = `${item.label} ${item.id} ${item.status} ${componentStlFilename(item)}`.toLowerCase();
      return belongs && presenceMatches && (!needle || groupMatches || searchable.includes(needle));
    });
    if (needle && !groupMatches && !items.length) continue;
    const section = document.createElement("section");
    section.className = `component-group ${collapsedGroups.has(group.id || "ungrouped") ? "collapsed" : ""}`;
    const header = document.createElement("div");
    header.className = "component-group-header";
    let collapse = null;
    if (!group.system) {
      collapse = document.createElement("button");
      collapse.type = "button";
      collapse.className = "group-collapse";
      collapse.innerHTML = flatIcon("chevron");
      collapse.title = t("groups.toggleTitle");
      collapse.addEventListener("click", () => {
        collapsedGroups.has(group.id) ? collapsedGroups.delete(group.id) : collapsedGroups.add(group.id);
        renderComponentList($("#componentSearch").value);
      });
    } else {
      header.classList.add("system");
    }
    const name = document.createElement("input");
    name.className = "group-name";
    name.value = group.name;
    name.maxLength = 80;
    name.setAttribute("aria-label", t("groups.nameLabel"));
    name.addEventListener("change", async () => {
      const nextName = name.value.trim();
      if (!nextName || nextName === group.name) { name.value = group.name; return; }
      const operation = group.system
        ? { type: "rename_ungrouped", name: nextName }
        : { type: "rename_group", groupId: group.id, name: nextName };
      try {
        await applyOperations([operation], "grouping");
        toast(t("groups.renamed"));
      } catch (error) { name.value = group.name; toast(error.message, "error"); }
    });
    name.addEventListener("keydown", (event) => { if (event.key === "Enter") name.blur(); });
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = items.length;
    if (collapse) header.append(collapse);
    header.append(name, count);
    if (!group.system) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "group-delete";
      remove.innerHTML = flatIcon("close");
      remove.title = t("groups.deleteTitle");
      remove.addEventListener("click", async () => {
        if (!window.confirm(t("groups.deleteConfirm", { name: group.name }))) return;
        try {
          await applyOperations([{ type: "delete_group", groupId: group.id }], "grouping");
          toast(t("groups.deleted"));
        } catch (error) { toast(error.message, "error"); }
      });
      header.append(remove);
    }
    const body = document.createElement("div");
    body.className = "component-group-items";
    section.addEventListener("dragover", (event) => {
      if (!draggedComponentId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearGroupDropTargets();
      section.classList.add("drop-target");
    });
    section.addEventListener("dragleave", (event) => {
      if (!section.contains(event.relatedTarget)) section.classList.remove("drop-target");
    });
    section.addEventListener("drop", async (event) => {
      event.preventDefault();
      const componentId = draggedComponentId || event.dataTransfer.getData("text/plain");
      draggedComponentId = null;
      clearGroupDropTargets();
      if (!componentId || (component(componentId).groupId || null) === group.id) return;
      try {
        await applyOperations([{ type: "assign_group", componentId, groupId: group.id }], "grouping");
        toast(t("groups.assigned", { name: component(componentId).label, group: group.name }));
      } catch (error) { toast(error.message, "error"); }
    });
    for (const item of items) body.append(componentListRow(item));
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "group-empty";
      empty.textContent = t("groups.empty");
      body.append(empty);
    }
    section.append(header, body);
    list.append(section);
  }
  for (const preview of list.querySelectorAll(".part-preview:not([src]), .part-preview[src='']")) {
    if (!component(preview.dataset.thumbnail)?.visible) previewObserver.observe(preview);
  }
}

function revealSelectedComponent(clearSearch = false) {
  if (!selectedId) return;
  if (clearSearch) {
    $("#componentSearch").value = "";
    componentPresenceFilter = "all";
    for (const button of document.querySelectorAll(".presence-filter-button")) {
      button.classList.toggle("active", button.dataset.presence === "all");
    }
    renderComponentList();
  }
  const row = document.querySelector(`.component-item[data-id="${CSS.escape(selectedId)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.classList.remove("revealed");
  void row.offsetWidth;
  row.classList.add("revealed");
  window.setTimeout(() => row.classList.remove("revealed"), 900);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function flatIcon(name) {
  const paths = {
    chevron: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  return `<svg class="flat-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}

const anchorCollections = [
  ["seats", "seat", "anchors.seats"],
  ["holes", "hole", "anchors.holes"],
  ["planes", "plane", "anchors.faces"],
  ["midplanes", "midplane", "anchors.midplanes"],
  ["shafts", "shaft", "anchors.shafts"],
  ["edges", "edge", "anchors.edges"],
  ["points", "point", "anchors.points"],
  ["centers", "center", "anchors.centers"],
];

function anchorDescription(type, item) {
  if (type === "hole") return `Ø${Number(item.diameterMm || 0).toFixed(2)} · ${Number(item.depthMm || 0).toFixed(2)} mm`;
  if (["shaft", "seat"].includes(type)) return `Ø${Number(item.diameterMm || 0).toFixed(2)} · ${Number(item.lengthMm || 0).toFixed(2)} mm`;
  if (["plane", "midplane"].includes(type)) return `${Number(item.areaMm2 || 0).toFixed(1)} mm²`;
  if (type === "edge") return `${Number(item.lengthMm || 0).toFixed(2)} mm`;
  return item.id;
}

function anchorTreeRole(ref) {
  if (fastenerTargetRefs.some((target) => sameSnapRef(target, ref))) return "source";
  if (mateMode && turnbuckleMode) {
    if (ref.interfaceType !== "hole") return "incompatible";
    if (!turnbuckleSelections.length) return "pick";
    return sameSnapRef(ref, turnbuckleSelections[0]) ? "source" : "target";
  }
  if (mateMode && throughMode) {
    const stage = throughSelections.length;
    if (stage === 0) return ["hole", "shaft"].includes(ref.interfaceType) ? "pick" : "incompatible";
    if (sameSnapRef(ref, throughSelections[0])) return "source";
    if (!["hole", "seat"].includes(ref.interfaceType) || ref.componentId === throughSelections[0].componentId) return "incompatible";
    if (stage > 1 && ref.componentId === throughSelections[1].componentId) return "incompatible";
    return "target";
  }
  if (!mateMode || !sourceHoleRef || patternMode) return "pick";
  if (sameSnapRef(ref, sourceHoleRef)) return "source";
  if (ref.componentId === sourceHoleRef.componentId) return "pick";
  return snapPairCompatible(sourceHoleRef, ref) ? "target" : "incompatible";
}

async function chooseAnchorFromTree(ref, additive = false) {
  if (!mateMode) startMateMode();
  await chooseHoleMarker({ userData: { snapRef: ref, holeRole: anchorTreeRole(ref) } }, additive);
  if (selectedId) renderAnchorTree(component(selectedId));
}

function renderAnchorTree(item) {
  const tree = $("#anchorTree");
  if (!tree) return;
  tree.replaceChildren();
  const total = anchorCollections.reduce((sum, [collection, type]) => {
    const count = item?.interfaces?.[collection]?.length || 0;
    return sum + count * (["hole", "shaft"].includes(type) ? 2 : 1);
  }, 0);
  $("#anchorCount").textContent = String(total);
  if (!total) {
    const empty = document.createElement("p");
    empty.className = "anchor-tree-empty";
    empty.textContent = t("anchors.empty");
    tree.append(empty);
    return;
  }
  for (const [collection, type, labelKey] of anchorCollections) {
    const anchors = item.interfaces?.[collection] || [];
    if (!anchors.length) continue;
    const details = document.createElement("details");
    details.className = "anchor-category";
    details.open = ["seat", "hole"].includes(type);
    const summary = document.createElement("summary");
    summary.innerHTML = `${flatIcon("chevron")}<span>${escapeHtml(t(labelKey))}</span><b>${anchors.length}</b>`;
    details.append(summary);
    const rows = document.createElement("div");
    rows.className = "anchor-rows";
    for (const anchor of anchors) {
      const row = document.createElement("div");
      row.className = "anchor-row";
      const copy = document.createElement("span");
      copy.className = "anchor-row-copy";
      copy.innerHTML = `<strong>${escapeHtml(anchor.id)}</strong><small>${escapeHtml(anchorDescription(type, anchor))}</small>`;
      row.append(copy);
      const choices = ["hole", "shaft"].includes(type)
        ? [[-1, t("anchors.sideA")], [1, t("anchors.sideB")]]
        : [[null, t("anchors.select")]];
      const actions = document.createElement("span");
      actions.className = "anchor-row-actions";
      for (const [side, label] of choices) {
        const ref = { componentId: item.id, interfaceType: type, interfaceId: anchor.id };
        if (type === "hole") ref.openingSide = side;
        if (type === "shaft") ref.endpointSide = side;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `anchor-select ${anchorTreeRole(ref)}`;
        button.textContent = label;
        button.title = `${t(labelKey)} · ${anchor.id}`;
        button.addEventListener("click", (event) => chooseAnchorFromTree(
          ref, event.shiftKey || event.ctrlKey || event.metaKey,
        ));
        actions.append(button);
      }
      row.append(actions);
      rows.append(row);
    }
    details.append(rows);
    tree.append(details);
  }
}

function selectComponent(id, refreshList = true) {
  if (!meshes.has(id)) return;
  if (selectedId && selectedId !== id && component(selectedId)) syncMesh(component(selectedId));
  selectedId = id;
  const item = component(id);
  const mesh = meshes.get(id);
  transform.detach();
  if (item.visible && !item.locked && $("#selectMode").classList.contains("active") === false) transform.attach(mesh);
  $("#selectedLabel").textContent = item.label;
  const holeCount = holesFor(item).length;
  $("#selectedMeta").textContent = `${item.id} · ${item.status}${item.visible ? "" : t("selection.removedSuffix")}${item.locked ? t("selection.lockedSuffix") : ""}${t("selection.magnetsSuffix", {
    holes: holeCount,
    planes: item.interfaces?.planes?.length || 0,
    shafts: item.interfaces?.shafts?.length || 0,
  })}`;
  $("#transformEditor").classList.remove("hidden");
  $("#revealComponent").classList.remove("hidden");
  $("#positionX").value = item.transform.positionMm[0].toFixed(3);
  $("#positionY").value = item.transform.positionMm[1].toFixed(3);
  $("#positionZ").value = item.transform.positionMm[2].toFixed(3);
  $("#partColor").value = item.color;
  $("#partColorValue").value = item.color.toUpperCase();
  $("#partMaterial").value = item.appearance || "default";
  $("#partOpacity").value = String(Math.round(effectiveOpacity(item) * 100));
  $("#partOpacityValue").value = `${Math.round(effectiveOpacity(item) * 100)}%`;
  $("#componentName").value = item.label;
  $("#componentStlFilename").value = componentStlFilename(item);
  populateParametricEditor(item);
  const groupSelect = $("#componentGroup");
  groupSelect.replaceChildren();
  groupSelect.add(new Option(state.workspace?.ungroupedName || t("groups.ungrouped"), ""));
  for (const group of state.groups || []) groupSelect.add(new Option(group.name, group.id));
  groupSelect.value = item.groupId || "";
  renderAnchorTree(item);
  $("#applyTransform").disabled = item.locked || !item.visible;
  $("#resetComponent").disabled = item.locked || !item.visible;
  $("#toggleComponentLock").textContent = t(item.locked ? "selection.unlock" : "selection.lock");
  $("#duplicateComponent").disabled = !item.meshUrl || ["fastener", "bearing"].includes(item.kind);
  $("#quickRotatePanel").classList.toggle(
    "hidden",
    !$("#rotateMode").classList.contains("active") || item.locked || !item.visible
      || Boolean(jointForComponent(id) && jointForComponent(id).type !== "rigid"),
  );
  $("#selectionSummary").textContent = `${item.label} · ${item.triangles.toLocaleString("it-IT")} triangoli`;
  for (const [meshId, object] of meshes) {
    object.material.emissive.setHex(meshId === id ? 0x163a50 : 0x000000);
    object.material.emissiveIntensity = meshId === id ? 0.7 : 0;
  }
  if (mateMode) renderMateMarkers();
  if (refreshList) {
    renderComponentList($("#componentSearch").value);
    requestAnimationFrame(() => revealSelectedComponent(false));
  }
}

function setTransformMode(mode) {
  if (mateMode) cancelMateMode();
  const activeJoint = selectedId ? jointForComponent(selectedId) : null;
  if (mode === "translate" && ["hinge", "ball", "gear"].includes(activeJoint?.type)) mode = "rotate";
  if (mode === "rotate" && activeJoint?.type === "slider") mode = "translate";
  const item = selectedId && component(selectedId);
  $("#quickRotatePanel").classList.toggle(
    "hidden",
    mode !== "rotate" || !item?.visible || item.locked || Boolean(activeJoint && activeJoint.type !== "rigid"),
  );
  for (const id of ["selectMode", "translateMode", "rotateMode"]) $("#" + id).classList.remove("active");
  if (mode === "translate") {
    $("#translateMode").classList.add("active");
    transform.setMode("translate");
  } else if (mode === "rotate") {
    $("#rotateMode").classList.add("active");
    transform.setMode("rotate");
  } else {
    $("#selectMode").classList.add("active");
    transform.detach();
    return;
  }
  if (item?.visible && !item.locked) {
    configureJointGizmo(activeJoint);
    transform.attach(meshes.get(selectedId));
  }
}

async function applyQuickRotation(degrees) {
  if (quickRotateBusy || !selectedId) return;
  quickRotateBusy = true;
  for (const button of document.querySelectorAll(".quick-rotate")) button.disabled = true;
  try {
    await applyOperations([{
      type: "transform_delta",
      componentId: selectedId,
      deltaMm: [0, 0, 0],
      rotationAxis: quickRotateAxis,
      rotationDegrees: degrees,
    }], "quick-rotation");
    toast(t("rotate.quickApplied", { degrees, axis: quickRotateAxis.toUpperCase() }));
  } catch (error) { toast(error.message, "error"); }
  finally {
    quickRotateBusy = false;
    for (const button of document.querySelectorAll(".quick-rotate")) button.disabled = false;
  }
}

function configureJointGizmo(joint) {
  transform.showX = true; transform.showY = true; transform.showZ = true;
  transform.setSpace(joint ? "local" : "world");
  if (!joint || !["hinge", "slider", "gear"].includes(joint.type)) return;
  const sourceRef = Array.isArray(joint.source) ? joint.source[0] : joint.source;
  const item = snapItem(sourceRef);
  if (!item) return;
  const axis = ["plane", "midplane"].includes(sourceRef.interfaceType)
    ? item.localNormal
    : sourceRef.interfaceType === "edge" ? item.localDirection : item.localAxis || [0, 0, 1];
  const dominant = axis.map(Math.abs).indexOf(Math.max(...axis.map(Math.abs)));
  transform.showX = dominant === 0;
  transform.showY = dominant === 1;
  transform.showZ = dominant === 2;
}

function clearHoleMarkers() {
  for (const marker of holeMarkers.splice(0)) {
    scene.remove(marker);
    marker.geometry.dispose();
    marker.material.dispose();
  }
}

function addHoleMarker(ref, role) {
  const hole = holeFor(ref);
  const world = holeWorldData(ref);
  if (!hole || !world) return;
  const openingSide = [-1, 1].includes(Number(ref.openingSide)) ? Number(ref.openingSide) : 1;
  const outward = world.axis.clone().multiplyScalar(openingSide);
  const color = role === "target"
    ? 0x45e1c2
    : role === "source"
      ? 0xff9d3f
      : role === "incompatible"
        ? 0xd05b65
        : 0x58bfff;
  // Deliberately oversized marker for reliable picking from a distant view.
  const geometry = new THREE.TorusGeometry(Math.max(hole.radiusMm, 2), 0.8, 10, 28);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const marker = new THREE.Mesh(geometry, material);
  // Keep every opening selectable even when the hole is behind the solid.
  // This is a CAD overlay, not scene geometry, so it intentionally ignores depth.
  marker.position.copy(world.openings[openingSide === -1 ? 0 : 1]).addScaledVector(outward, 0.7);
  marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
  marker.scale.setScalar(role === "source" ? 1.18 : 1);
  marker.renderOrder = 1000;
  marker.userData.holeRef = ref;
  marker.userData.snapRef = {
    componentId: ref.componentId,
    interfaceType: "hole",
    interfaceId: ref.holeId || ref.interfaceId,
    openingSide,
  };
  marker.userData.holeRole = role;
  scene.add(marker);
  holeMarkers.push(marker);
}

function addSnapMarker(ref, role) {
  if (ref.interfaceType === "hole") {
    addHoleMarker({ ...ref, holeId: ref.interfaceId }, role);
    return;
  }
  const item = snapItem(ref);
  const mesh = meshes.get(ref.componentId);
  if (!item || !mesh) return;
  let localPoint;
  let localNormal;
  let localDirection = null;
  let geometry;
  if (["plane", "midplane"].includes(ref.interfaceType)) {
    localPoint = new THREE.Vector3().fromArray(item.localCenterMm);
    localNormal = new THREE.Vector3().fromArray(item.localNormal).normalize();
    const radius = THREE.MathUtils.clamp(Math.sqrt(item.areaMm2) * 0.12, 2.5, 8);
    geometry = new THREE.RingGeometry(radius * 0.58, radius, 4, 1);
    geometry.rotateZ(Math.PI / 4);
  } else if (ref.interfaceType === "shaft") {
    const side = Number(ref.endpointSide);
    localNormal = new THREE.Vector3().fromArray(item.localAxis).normalize().multiplyScalar(side);
    localPoint = new THREE.Vector3().fromArray(item.localCenterMm)
      .addScaledVector(new THREE.Vector3().fromArray(item.localAxis), item.lengthMm * 0.5 * side);
    geometry = new THREE.CircleGeometry(THREE.MathUtils.clamp(item.radiusMm, 2, 7), 24);
  } else if (ref.interfaceType === "seat") {
    localPoint = new THREE.Vector3().fromArray(item.localCenterMm);
    localNormal = new THREE.Vector3().fromArray(item.localAxis).normalize();
    const radius = THREE.MathUtils.clamp(item.radiusMm, 2.5, 9);
    geometry = new THREE.RingGeometry(radius * .58, radius, 32, 1, 0, Math.PI);
  } else if (ref.interfaceType === "edge") {
    localPoint = new THREE.Vector3().fromArray(item.localCenterMm);
    localDirection = new THREE.Vector3().fromArray(item.localDirection).normalize();
    geometry = new THREE.CylinderGeometry(0.65, 0.65, Math.min(item.lengthMm, 24), 8);
  } else {
    localPoint = new THREE.Vector3().fromArray(item.localPointMm);
    geometry = new THREE.SphereGeometry(ref.interfaceType === "center" ? 2.8 : 1.7, 10, 8);
  }
  const worldPoint = localPoint.clone().applyQuaternion(mesh.quaternion).add(mesh.position);
  const typeColors = {
    plane: 0xb46cff, midplane: 0xe07cff, shaft: 0x53d9ff, seat: 0x45e1c2, edge: 0xffd35a,
    point: 0xffffff, center: 0xff7ab8,
  };
  const baseColor = typeColors[ref.interfaceType];
  const color = role === "source" ? 0xff9d3f : role === "target" ? 0x45e1c2 : role === "incompatible" ? 0xd05b65 : baseColor;
  const marker = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  }));
  marker.position.copy(worldPoint);
  if (localNormal) {
    const worldNormal = localNormal.clone().applyQuaternion(mesh.quaternion).normalize();
    marker.position.addScaledVector(worldNormal, 0.7);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  } else if (localDirection) {
    const worldDirection = localDirection.applyQuaternion(mesh.quaternion).normalize();
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldDirection);
  }
  marker.renderOrder = 1000;
  if (ref.interfaceType === "seat") marker.scale.setScalar(1.35);
  marker.userData.snapRef = ref;
  marker.userData.holeRole = role;
  marker.userData.holeRef = ref;
  scene.add(marker);
  holeMarkers.push(marker);
}

function renderMateMarkers() {
  clearHoleMarkers();
  if (!mateMode) return;
  const focusedItems = state.components.filter((item) => item.visible && meshes.has(item.id)
    && snapFocusedComponentIds.has(item.id));
  if (turnbuckleMode) {
    for (const item of focusedItems) {
      for (const ref of snapRefsFor(item)) {
        if (ref.interfaceType !== "hole") continue;
        const role = turnbuckleSelections.some((selected) => sameSnapRef(selected, ref))
          ? "source" : turnbuckleSelections.length ? "target" : "pick";
        addSnapMarker(ref, role);
      }
    }
    return;
  }
  if (throughMode) {
    const stage = throughSelections.length;
    for (const item of focusedItems) {
      for (const ref of snapRefsFor(item)) {
        let role = "incompatible";
        if (stage === 0 && ["hole", "shaft"].includes(ref.interfaceType)) role = "pick";
        else if (stage === 0 && ref.interfaceType === "seat") role = "target";
        else if (stage > 0 && sameSnapRef(ref, throughSelections[0])) role = "source";
        else if (stage > 0 && ["hole", "seat"].includes(ref.interfaceType)
          && ref.componentId !== throughSelections[0].componentId
          && (stage < 2 || ref.componentId !== throughSelections[1].componentId)) role = "target";
        if (role !== "incompatible") addSnapMarker(ref, role);
      }
    }
    return;
  }
  if (!sourceHoleRef) {
    for (const item of focusedItems) {
      for (const ref of snapRefsFor(item)) {
        if (snapRefPassesActiveFilter(ref)) addSnapMarker(ref, "pick");
      }
    }
    return;
  }
  for (const target of focusedItems) {
    for (const ref of snapRefsFor(target)) {
      if (snapRefPassesActiveFilter(ref)) {
        const role = sameSnapRef(ref, sourceHoleRef)
          || fastenerTargetRefs.some((selected) => sameSnapRef(selected, ref))
          ? "source"
          : target.id === sourceHoleRef.componentId
            ? "pick"
            : snapPairCompatible(sourceHoleRef, ref) ? "target" : "incompatible";
        addSnapMarker(ref, role);
      }
    }
  }
}

function setSnapComponentFocus(componentId, additive = false) {
  if (!additive) snapFocusedComponentIds.clear();
  if (additive && snapFocusedComponentIds.has(componentId)) snapFocusedComponentIds.delete(componentId);
  else snapFocusedComponentIds.add(componentId);
  setStatus(t("snap.focus", { count: snapFocusedComponentIds.size }));
}

function renderDragMagnetMarkers(componentId) {
  clearHoleMarkers();
  if (!magnetEnabled) return;
  const source = component(componentId);
  const sourceHoles = holesFor(source);
  for (const hole of sourceHoles) for (const openingSide of [-1, 1]) {
    addHoleMarker({ componentId, holeId: hole.id, openingSide }, "source");
  }
  for (const target of state.components) {
    if (target.id === componentId || !target.visible || !meshes.has(target.id)) continue;
    for (const targetHole of holesFor(target)) {
      if (!sourceHoles.some((sourceHole) => compatibleHoles(sourceHole, targetHole))) continue;
      for (const openingSide of [-1, 1]) {
        addHoleMarker({ componentId: target.id, holeId: targetHole.id, openingSide }, "target");
      }
    }
  }
}

function updateHoleMarkers(componentId) {
  for (const marker of holeMarkers) {
    const ref = marker.userData.holeRef;
    if (ref.componentId !== componentId) continue;
    const world = holeWorldData(ref);
    if (!world) continue;
    const side = Number(ref.openingSide);
    const outward = world.axis.clone().multiplyScalar(side);
    marker.position.copy(world.openings[side === -1 ? 0 : 1]).addScaledVector(outward, 0.7);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
  }
}

function sameOpening(first, second) {
  return first?.componentId === second?.componentId
    && first?.holeId === second?.holeId
    && Number(first?.openingSide) === Number(second?.openingSide);
}

function sameSnapRef(first, second) {
  return first?.componentId === second?.componentId
    && first?.interfaceType === second?.interfaceType
    && first?.interfaceId === second?.interfaceId
    && Number(first?.openingSide || 0) === Number(second?.openingSide || 0)
    && Number(first?.endpointSide || 0) === Number(second?.endpointSide || 0);
}

function highlightMagnetCandidate(candidate) {
  for (const marker of holeMarkers) {
    const active = candidate && (
      sameOpening(marker.userData.holeRef, candidate.source)
      || sameOpening(marker.userData.holeRef, candidate.target)
    );
    marker.material.opacity = candidate ? (active ? 1 : 0.52) : 0.92;
    marker.scale.setScalar(active ? 1.55 : marker.userData.holeRole === "source" ? 1.18 : 1);
  }
}

function applyLocalHoleSnap(candidate) {
  const sourceHole = holeFor(candidate.source);
  const targetWorld = holeWorldData(candidate.target);
  const mesh = meshes.get(candidate.source.componentId);
  if (!sourceHole || !targetWorld || !mesh) return;
  const sourceSide = Number(candidate.source.openingSide);
  const targetSide = Number(candidate.target.openingSide);
  const sourceOutward = new THREE.Vector3().fromArray(sourceHole.localAxis)
    .applyQuaternion(mesh.quaternion).normalize().multiplyScalar(sourceSide);
  const targetOutward = targetWorld.axis.clone().multiplyScalar(targetSide);
  const delta = new THREE.Quaternion().setFromUnitVectors(sourceOutward, targetOutward.negate());
  mesh.quaternion.premultiply(delta).normalize();
  const localOpening = new THREE.Vector3().fromArray(sourceHole.localCenterMm)
    .addScaledVector(new THREE.Vector3().fromArray(sourceHole.localAxis), sourceHole.depthMm * 0.5 * sourceSide)
    .applyQuaternion(mesh.quaternion);
  const targetOpening = targetWorld.openings[targetSide === -1 ? 0 : 1];
  mesh.position.copy(targetOpening).sub(localOpening);
  mesh.updateMatrixWorld();
}

function startMateMode() {
  lastSnapMate = null;
  $("#snapRotatePanel").classList.add("hidden");
  $("#jointPanel").classList.add("hidden");
  setTransformMode("select");
  mateMode = true;
  $("#mateMode").classList.add("active");
  $("#magnetToggle").classList.add("active");
  $("#magnetToggle span").textContent = t("snap.on");
  $("#matePanel").classList.remove("hidden");
  $("#mateStatus").textContent = t("mate.pickFirst");
  sourceHoleRef = null;
  fastenerTargetRefs = [];
  patternSelections = [];
  throughMode = false;
  throughSelections = [];
  turnbuckleMode = false;
  turnbuckleSelections = [];
  snapFocusedComponentIds.clear();
  if (selectedId && component(selectedId)?.visible) snapFocusedComponentIds.add(selectedId);
  pendingMate = null;
  $("#addFastenerFromHole").classList.add("hidden");
  $("#addBearingFromAnchor").classList.add("hidden");
  syncPlaneMateOptions();
  renderMateMarkers();
  if (selectedId) renderAnchorTree(component(selectedId));
  if (!snapFocusedComponentIds.size) {
    $("#mateStatus").textContent = t("snap.clickPart");
    setStatus(t("snap.clickPart"));
  } else setStatus(t("mate.firstStatus"));
}

function syncPlaneMateOptions() {
  const visible = ["all", "plane"].includes($("#snapFilter").value);
  $("#planeMateOptions").classList.toggle("hidden", !visible);
  for (const button of document.querySelectorAll(".plane-mode-button")) {
    button.classList.toggle("active", button.dataset.planeMode === planeMateMode);
  }
  $("#planeMateHelp").textContent = t(
    planeMateMode === "slide" ? "planeMode.slideHelp" : "planeMode.centerHelp",
  );
}

function openFastenerDialog() {
  const targets = fastenerTargetRefs.length ? fastenerTargetRefs : [sourceHoleRef];
  if (!targets.length || targets.some((target) => target?.interfaceType !== "hole")) return;
  const hole = holeFor(targets[0]);
  if (!hole) return;
  const suggested = [2, 2.5, 3, 4, 5, 6, 8].reduce(
    (best, size) => Math.abs(size - hole.diameterMm) < Math.abs(best - hole.diameterMm) ? size : best,
    3,
  );
  $("#fastenerDiameter").value = String(suggested);
  $("#fastenerFlip").checked = false;
  $("#fastenerTargetLabel").textContent = targets.length > 1
    ? t("fastener.targets", { count: targets.length })
    : t("fastener.target", {
      part: component(targets[0].componentId).label,
      hole: targets[0].interfaceId,
      diameter: Number(hole.diameterMm).toFixed(2),
    });
  const dialog = $("#fastenerDialog");
  if (!dialog.open) dialog.showModal();
}

async function insertFastener() {
  const targets = fastenerTargetRefs.length ? fastenerTargetRefs : [sourceHoleRef];
  if (!targets.length || targets.some((target) => target?.interfaceType !== "hole")) return;
  const button = $("#confirmFastener");
  setBusy(button, true, t("fastener.inserting"));
  try {
    const result = await applyOperations(targets.map((target) => ({
      type: "add_fastener",
      target: { ...target },
      standard: $("#fastenerStandard").value,
      diameterMm: Number($("#fastenerDiameter").value),
      lengthMm: Number($("#fastenerLength").value),
      flip: $("#fastenerFlip").checked,
    })), "fastener");
    const fastenerIds = result.affected;
    const fastenerId = fastenerIds.at(-1);
    $("#fastenerDialog").close("inserted");
    cancelMateMode();
    selectComponent(fastenerId);
    setTransformMode("translate");
    toast(fastenerIds.length > 1
      ? t("fastener.insertedMany", { count: fastenerIds.length })
      : t("fastener.inserted", { name: component(fastenerId).label }));
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(button, false); }
}

function renderBearingCatalog() {
  const entries = Object.entries(bearingCatalog).sort(([, first], [, second]) =>
    first.innerDiameterMm - second.innerDiameterMm
    || first.outerDiameterMm - second.outerDiameterMm
    || first.widthMm - second.widthMm);
  for (const select of [$("#bearingSeries"), $("#editBearingSeries")]) {
    select.replaceChildren();
    for (const [series, dimensions] of entries) {
      const option = document.createElement("option");
      option.value = series;
      option.textContent = `${series} · ${dimensions.innerDiameterMm}×${dimensions.outerDiameterMm}×${dimensions.widthMm}`;
      select.append(option);
    }
    const custom = document.createElement("option");
    custom.value = "CUSTOM";
    custom.textContent = t("bearing.custom");
    select.append(custom);
  }
}

function renderRcCatalog() {
  const container = $("#libraryItems");
  if (!container) return;
  container.replaceChildren();
  const scale = $("#libraryScale").value;
  const category = $("#libraryCategory").value;
  const items = rcCatalog.filter((item) =>
    (scale === "all" || item.scale.includes(scale))
    && (category === "all" || item.category === category));
  if (!items.some((item) => item.id === selectedRcCatalogId)) selectedRcCatalogId = null;
  for (const item of items) {
    if (!rcCatalogThumbnails.has(item.id)) {
      const colors = { motors: "#3e464d", electronics: "#30343a", steering: "#5a6066", power: "#245cc7" };
      const geometry = prepareComponentGeometry(catalogGeometry({ shape: item.shape }));
      rcCatalogThumbnails.set(item.id, geometryThumbnail(geometry, colors[item.category] || "#6b737a"));
      geometry.dispose();
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `library-item${item.id === selectedRcCatalogId ? " selected" : ""}`;
    button.dataset.catalogId = item.id;
    button.innerHTML = `<img src="${rcCatalogThumbnails.get(item.id)}" alt=""><strong>${escapeHtml(item.label)}</strong><b>${escapeHtml(item.scale)}</b><small>${escapeHtml(item.description)}</small>`;
    button.addEventListener("click", () => selectRcCatalogItem(item.id));
    container.append(button);
  }
  if (!selectedRcCatalogId && items.length) selectRcCatalogItem(items[0].id);
}

function selectRcCatalogItem(catalogId) {
  const item = rcCatalog.find((candidate) => candidate.id === catalogId);
  if (!item) return;
  selectedRcCatalogId = catalogId;
  for (const card of document.querySelectorAll(".library-item")) {
    card.classList.toggle("selected", card.dataset.catalogId === catalogId);
  }
  $("#libraryPreview").classList.remove("hidden");
  $("#libraryPreviewImage").src = rcCatalogThumbnails.get(catalogId) || "";
  $("#libraryPreviewImage").alt = item.label;
  $("#libraryPreviewScale").textContent = `${item.scale} · ${t(`library.${item.category}`)}`;
  $("#libraryPreviewTitle").textContent = item.label;
  $("#libraryPreviewDescription").textContent = item.description;
  $("#addLibraryComponent").disabled = false;
}

async function insertRcCatalogComponent() {
  if (!selectedRcCatalogId) return;
  const button = $("#addLibraryComponent");
  setBusy(button, true, t("library.adding"));
  try {
    const result = await applyOperations([{
      type: "add_catalog_component", catalogId: selectedRcCatalogId,
    }], "rc-catalog");
    const id = result.affected[0];
    $("#libraryDialog").close("inserted");
    selectComponent(id);
    setTransformMode("translate");
    toast(t("library.added", { name: component(id).label }));
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(button, false); }
}

function fastenerSpecFromEditor(item) {
  const standard = $("#editFastenerStandard").value;
  const diameterMm = Number($("#editFastenerDiameter").value);
  const dimensions = FASTENER_DIMENSIONS[standard]?.[diameterMm];
  if (!dimensions) return null;
  const [headDiameterMm, headHeightMm, socketAcrossFlatsMm, socketDepthMm] = dimensions;
  return {
    ...item.fastener,
    standard,
    diameterMm,
    lengthMm: Number($("#editFastenerLength").value),
    headDiameterMm,
    headHeightMm,
    socketAcrossFlatsMm,
    socketDepthMm,
    flipped: $("#editFastenerFlip").checked,
  };
}

function bearingSpecFromEditor(item) {
  return {
    ...item.bearing,
    series: $("#editBearingSeries").value,
    innerDiameterMm: Number($("#editBearingInner").value),
    outerDiameterMm: Number($("#editBearingOuter").value),
    widthMm: Number($("#editBearingWidth").value),
    closure: $("#editBearingClosure").value,
    sealColor: $("#editBearingSealColor").value,
  };
}

function previewParametricEdit() {
  const item = selectedId && component(selectedId);
  const mesh = item && meshes.get(item.id);
  if (!mesh || !["fastener", "bearing"].includes(item.kind)) return;
  const spec = item.kind === "fastener" ? fastenerSpecFromEditor(item) : bearingSpecFromEditor(item);
  if (!spec || Object.values(spec).some((value) => typeof value === "number" && !Number.isFinite(value))) return;
  if (item.kind === "fastener" && (spec.lengthMm < 4 || spec.lengthMm > 80)) return;
  if (item.kind === "bearing" && (spec.innerDiameterMm < .5
    || spec.outerDiameterMm <= spec.innerDiameterMm + .5 || spec.widthMm < .5)) return;
  const previewItem = { ...item, [item.kind]: spec };
  const geometry = prepareComponentGeometry(createComponentGeometry(previewItem));
  mesh.geometry.dispose();
  mesh.geometry = geometry;
  mesh.userData.geometrySignature = proceduralGeometrySignature(previewItem);
}

function populateParametricEditor(item) {
  const visible = ["fastener", "bearing"].includes(item.kind);
  $("#parametricEditor").classList.toggle("hidden", !visible);
  $("#fastenerEditor").classList.toggle("hidden", item.kind !== "fastener");
  $("#bearingEditor").classList.toggle("hidden", item.kind !== "bearing");
  if (!visible) return;
  $("#applyParametricEdit").disabled = item.locked || !item.visible;
  if (item.kind === "fastener") {
    $("#editFastenerStandard").value = item.fastener.standard;
    $("#editFastenerDiameter").value = String(item.fastener.diameterMm);
    $("#editFastenerLength").value = item.fastener.lengthMm;
    $("#editFastenerFlip").checked = Boolean(item.fastener.flipped);
  } else {
    $("#editBearingSeries").value = bearingCatalog[item.bearing.series] ? item.bearing.series : "CUSTOM";
    $("#editBearingClosure").value = item.bearing.closure;
    $("#editBearingInner").value = item.bearing.innerDiameterMm;
    $("#editBearingOuter").value = item.bearing.outerDiameterMm;
    $("#editBearingWidth").value = item.bearing.widthMm;
    $("#editBearingSealColor").value = item.bearing.sealColor;
  }
}

async function applyParametricEdit() {
  const item = selectedId && component(selectedId);
  if (!item || !["fastener", "bearing"].includes(item.kind)) return;
  const fastenerSpec = item.kind === "fastener" ? fastenerSpecFromEditor(item) : null;
  const operation = item.kind === "fastener"
    ? { type: "update_fastener", componentId: item.id, ...fastenerSpec, flip: fastenerSpec.flipped }
    : { type: "update_bearing", componentId: item.id, ...bearingSpecFromEditor(item) };
  const button = $("#applyParametricEdit");
  setBusy(button, true, t("parametric.applying"));
  try {
    await applyOperations([operation], "parametric-edit");
    syncMesh(component(item.id));
    const thumbnail = geometryThumbnail(meshes.get(item.id).geometry, component(item.id).color);
    thumbnails.set(item.id, thumbnail);
    const preview = document.querySelector(`[data-thumbnail="${CSS.escape(item.id)}"]`);
    if (preview) preview.src = thumbnail;
    selectComponent(item.id, false);
    toast(t("parametric.saved"));
  } catch (error) {
    syncMesh(component(item.id));
    toast(error.message, "error");
  } finally { setBusy(button, false); }
}

function resetParametricEdit() {
  const item = selectedId && component(selectedId);
  if (!item) return;
  syncMesh(item);
  populateParametricEditor(item);
}

async function toggleSelectedComponentLock() {
  const item = selectedId && component(selectedId);
  if (!item) return;
  try {
    await applyOperations([{
      type: "lock_component", componentId: item.id, locked: !item.locked,
    }], "component-lock");
    selectComponent(item.id, false);
    toast(t(component(item.id).locked ? "selection.locked" : "selection.unlocked"));
  } catch (error) { toast(error.message, "error"); }
}

function syncBearingDimensions() {
  const dimensions = bearingCatalog[$("#bearingSeries").value];
  if (!dimensions) return;
  $("#bearingInnerDiameter").value = dimensions.innerDiameterMm;
  $("#bearingOuterDiameter").value = dimensions.outerDiameterMm;
  $("#bearingWidth").value = dimensions.widthMm;
}

function syncBearingClosureColor() {
  const colors = { open: "#c69b46", zz: "#c8cdd1", "2rs": "#202326" };
  $("#bearingSealColor").value = colors[$("#bearingClosure").value];
}

function coaxialShaftDiameterForHole(ref) {
  const targetWorld = holeWorldData(ref);
  const targetHole = snapItem(ref);
  if (!targetWorld || !targetHole) return null;
  let best = null;
  for (const candidate of state.components.filter((item) => item.visible)) {
    const mesh = meshes.get(candidate.id);
    if (!mesh) continue;
    for (const shaft of candidate.interfaces?.shafts || []) {
      const center = new THREE.Vector3(...shaft.localCenterMm).applyQuaternion(mesh.quaternion).add(mesh.position);
      const axis = new THREE.Vector3(...shaft.localAxis).applyQuaternion(mesh.quaternion).normalize();
      const alignment = Math.abs(axis.dot(targetWorld.axis));
      if (alignment < .992) continue;
      const delta = targetWorld.center.clone().sub(center);
      const axialDistance = Math.abs(delta.dot(axis));
      const radialDistance = delta.clone().addScaledVector(axis, -delta.dot(axis)).length();
      const axialLimit = Number(shaft.lengthMm || 0) / 2 + Number(targetHole.depthMm || 0) / 2 + 5;
      if (radialDistance > Math.max(.6, Number(targetHole.radiusMm || 0) * .2) || axialDistance > axialLimit) continue;
      const score = radialDistance + (1 - alignment) * 20 + axialDistance * .01;
      if (!best || score < best.score) best = { score, diameterMm: Number(shaft.diameterMm) };
    }
  }
  return best?.diameterMm || null;
}

function openBearingDialog() {
  if (!sourceHoleRef || !["hole", "shaft"].includes(sourceHoleRef.interfaceType)) return;
  const anchor = snapItem(sourceHoleRef);
  if (!anchor) return;
  const diameter = Number(anchor.diameterMm);
  const inferredShaftDiameter = sourceHoleRef.interfaceType === "hole"
    ? coaxialShaftDiameterForHole(sourceHoleRef) : diameter;
  const score = (dimensions) => sourceHoleRef.interfaceType === "shaft"
    ? Math.abs(dimensions.innerDiameterMm - diameter)
    : Math.abs(dimensions.outerDiameterMm - diameter)
      + (inferredShaftDiameter == null ? 0 : Math.abs(dimensions.innerDiameterMm - inferredShaftDiameter) * 1.25);
  const [closestSeries] = Object.entries(bearingCatalog).sort(([, first], [, second]) =>
    score(first) - score(second))[0] || ["CUSTOM"];
  $("#bearingSeries").value = closestSeries;
  syncBearingDimensions();
  const targetDescription = t("bearing.target", {
    part: component(sourceHoleRef.componentId).label, anchor: sourceHoleRef.interfaceId,
    diameter: Number(diameter || 0).toFixed(2),
  });
  $("#bearingTargetLabel").textContent = `${targetDescription} · ${t(
    inferredShaftDiameter != null && sourceHoleRef.interfaceType === "hole"
      ? "bearing.autoHoleShaft" : sourceHoleRef.interfaceType === "hole" ? "bearing.autoHole" : "bearing.autoShaft",
    { series: closestSeries },
  )}`;
  $("#bearingDialog").showModal();
}

async function insertBearing() {
  if (!sourceHoleRef || !["hole", "shaft"].includes(sourceHoleRef.interfaceType)) return;
  const target = { ...sourceHoleRef };
  const button = $("#confirmBearing");
  setBusy(button, true, t("bearing.inserting"));
  try {
    const result = await applyOperations([{
      type: "add_bearing", target, series: $("#bearingSeries").value,
      innerDiameterMm: Number($("#bearingInnerDiameter").value),
      outerDiameterMm: Number($("#bearingOuterDiameter").value),
      widthMm: Number($("#bearingWidth").value),
      closure: $("#bearingClosure").value,
      sealColor: $("#bearingSealColor").value,
    }], "bearing");
    const bearingId = result.affected[0];
    $("#bearingDialog").close("inserted");
    cancelMateMode();
    selectComponent(bearingId);
    setTransformMode("translate");
    toast(t("bearing.inserted", { name: component(bearingId).label }));
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(button, false); }
}

function cancelMateMode() {
  mateMode = false;
  sourceHoleRef = null;
  fastenerTargetRefs = [];
  pendingMate = null;
  patternMode = false;
  patternSelections = [];
  throughMode = false;
  throughSelections = [];
  turnbuckleMode = false;
  turnbuckleSelections = [];
  snapFocusedComponentIds.clear();
  $("#patternToggle").classList.remove("active");
  $("#throughToggle").classList.remove("active");
  $("#turnbuckleToggle").classList.remove("active");
  clearHoleMarkers();
  clearGhosts();
  $("#mateMode").classList.remove("active");
  $("#magnetToggle").classList.remove("active");
  $("#magnetToggle span").textContent = t("snap.off");
  $("#matePanel").classList.add("hidden");
  $("#mateSummary").classList.add("hidden");
  $("#applyMate").disabled = true;
  $("#addFastenerFromHole").classList.add("hidden");
  $("#addBearingFromAnchor").classList.add("hidden");
  if (selectedId) renderAnchorTree(component(selectedId));
}

async function chooseHoleMarker(marker, additive = false) {
  const ref = marker.userData.snapRef || marker.userData.holeRef;
  if (turnbuckleMode) {
    await chooseTurnbuckleMarker(ref);
    return;
  }
  if (throughMode) {
    await chooseThroughMarker(ref);
    return;
  }
  if (patternMode) {
    await choosePatternMarker(ref);
    return;
  }
  if (additive && ref.interfaceType === "hole") {
    const existing = fastenerTargetRefs.findIndex((target) => sameSnapRef(target, ref));
    if (existing >= 0) fastenerTargetRefs.splice(existing, 1);
    else fastenerTargetRefs.push({ ...ref });
    sourceHoleRef = fastenerTargetRefs.at(-1) || null;
    pendingMate = null;
    $("#applyMate").disabled = true;
    $("#addFastenerFromHole").classList.toggle("hidden", !fastenerTargetRefs.length);
    $("#addBearingFromAnchor").classList.add("hidden");
    $("#mateStatus").textContent = fastenerTargetRefs.length
      ? t("fastener.selected", { count: fastenerTargetRefs.length })
      : t("mate.pickFirst");
    renderMateMarkers();
    if (selectedId) renderAnchorTree(component(selectedId));
    return;
  }
  if (marker.userData.holeRole === "incompatible") {
    toast(t("mate.incompatible"), "error");
    return;
  }
  if (marker.userData.holeRole === "pick" || marker.userData.holeRole === "source") {
    sourceHoleRef = ref;
    fastenerTargetRefs = ref.interfaceType === "hole" ? [{ ...ref }] : [];
    pendingMate = null;
    $("#applyMate").disabled = true;
    $("#mateStatus").textContent = t("mate.pickSecond");
    $("#addFastenerFromHole").classList.toggle("hidden", ref.interfaceType !== "hole");
    $("#addBearingFromAnchor").classList.toggle("hidden", !["hole", "shaft"].includes(ref.interfaceType));
    syncPlaneMateOptions();
    renderMateMarkers();
    if (selectedId) renderAnchorTree(component(selectedId));
    setStatus(t("mate.secondStatus"));
    return;
  }
  if (!sourceHoleRef) return;
  try {
    let source = sourceHoleRef;
    let target = ref;
    if (component(source.componentId).locked) {
      if (component(target.componentId).locked) throw new Error(t("mate.bothLocked"));
      [source, target] = [target, source];
    }
    const result = await api("/api/snaps/apply", {
      method: "POST",
      body: JSON.stringify({ source, target, planeMode: planeMateMode }),
    });
    state = result.state;
    const movedComponentId = result.mate.source.componentId;
    cancelMateMode();
    selectedId = null;
    await reconcileMeshesWithState();
    selectComponent(movedComponentId);
    setTransformMode("translate");
    renderComponentList($("#componentSearch").value);
    renderValidation();
    updateRevision();
    lastSnapMate = result.mate;
    snapRotationTotal = 0;
    snapOffsetTotal = 0;
    updateSnapRotationStatus();
    $("#snapRotatePanel").classList.remove("hidden");
    $("#jointPanel").classList.remove("hidden");
    toast(t("mate.applied"));
    setStatus(t("mate.saved", { revision: state.revision }));
  } catch (error) {
    toast(error.message, "error");
  }
}

async function chooseTurnbuckleMarker(ref) {
  if (ref.interfaceType !== "hole") {
    toast(t("turnbuckle.holesOnly"), "error");
    return;
  }
  if (!turnbuckleSelections.length) {
    turnbuckleSelections = [{ ...ref }];
    sourceHoleRef = ref;
    $("#mateStatus").textContent = t("turnbuckle.pickSecond");
    renderMateMarkers();
    if (selectedId) renderAnchorTree(component(selectedId));
    return;
  }
  if (sameSnapRef(ref, turnbuckleSelections[0])) {
    toast(t("turnbuckle.differentHole"), "error");
    return;
  }
  const button = $("#turnbuckleToggle");
  setBusy(button, true, t("turnbuckle.creating"));
  try {
    const result = await applyOperations([{
      type: "add_turnbuckle", first: turnbuckleSelections[0], second: { ...ref },
    }], "turnbuckle");
    const id = result.affected[0];
    cancelMateMode();
    selectComponent(id);
    setTransformMode("translate");
    toast(t("turnbuckle.created", { length: component(id).turnbuckle.centerDistanceMm.toFixed(1) }));
  } catch (error) {
    turnbuckleSelections = [];
    sourceHoleRef = null;
    $("#mateStatus").textContent = t("turnbuckle.pickFirst");
    renderMateMarkers();
    toast(error.message, "error");
  } finally { setBusy(button, false); }
}

async function chooseThroughMarker(ref) {
  const stage = throughSelections.length;
  if (stage === 0) {
    if (!["hole", "shaft"].includes(ref.interfaceType)) {
      toast(t("through.axialOnly"), "error"); return;
    }
    throughSelections.push(ref);
    sourceHoleRef = ref;
    $("#mateStatus").textContent = t("through.pickFirstHole");
    renderMateMarkers();
    return;
  }
  if (!["hole", "seat"].includes(ref.interfaceType)) {
    toast(t("through.holesOnly"), "error"); return;
  }
  if (ref.componentId === throughSelections[0].componentId) {
    toast(t("through.otherPart"), "error"); return;
  }
  if (stage === 2 && ref.componentId === throughSelections[1].componentId) {
    toast(t("through.otherSupport"), "error"); return;
  }
  throughSelections.push(ref);
  if (throughSelections.length === 2) {
    $("#mateStatus").textContent = t("through.pickSecondHole");
    renderMateMarkers();
    return;
  }
  try {
    const result = await api("/api/snaps/through/apply", {
      method: "POST",
      body: JSON.stringify({
        shaft: throughSelections[0], firstHole: throughSelections[1], secondHole: throughSelections[2],
      }),
    });
    state = result.state;
    const movedComponentId = result.mate.source.componentId;
    cancelMateMode();
    selectedId = null;
    await reconcileMeshesWithState();
    selectComponent(movedComponentId);
    setTransformMode("translate");
    renderComponentList($("#componentSearch").value);
    renderValidation();
    updateRevision();
    lastSnapMate = result.mate;
    toast(t("through.applied"));
    setStatus(t("mate.saved", { revision: state.revision }));
  } catch (error) {
    toast(error.message, "error");
    throughSelections = [];
    sourceHoleRef = null;
    fastenerTargetRefs = [];
    $("#mateStatus").textContent = t("through.pickShaft");
    renderMateMarkers();
  }
}

async function choosePatternMarker(ref) {
  if (ref.interfaceType !== "hole") {
    toast(t("pattern.holesOnly"), "error");
    return;
  }
  const stage = patternSelections.length;
  if (stage === 1 && ref.componentId === patternSelections[0].componentId) {
    toast(t("pattern.sameTarget"), "error"); return;
  }
  if (stage === 2 && ref.componentId !== patternSelections[0].componentId) {
    toast(t("pattern.sameSource"), "error"); return;
  }
  if (stage === 3 && ref.componentId !== patternSelections[1].componentId) {
    toast(t("pattern.sameTarget"), "error"); return;
  }
  patternSelections.push(ref);
  const messages = ["pattern.pick2", "pattern.pick3", "pattern.pick4"];
  if (patternSelections.length < 4) {
    sourceHoleRef = patternSelections[0];
    $("#mateStatus").textContent = t(messages[patternSelections.length - 1]);
    renderMateMarkers();
    return;
  }
  let sources = [patternSelections[0], patternSelections[2]];
  let targets = [patternSelections[1], patternSelections[3]];
  if (component(sources[0].componentId).locked) [sources, targets] = [targets, sources];
  try {
    const result = await api("/api/snaps/pattern/apply", {
      method: "POST",
      body: JSON.stringify({ source: sources, target: targets }),
    });
    state = result.state;
    const movedComponentId = result.mate.source[0].componentId;
    cancelMateMode();
    selectedId = null;
    syncAllMeshes();
    selectComponent(movedComponentId);
    setTransformMode("translate");
    renderComponentList($("#componentSearch").value);
    renderValidation();
    updateRevision();
    lastSnapMate = result.mate;
    $("#jointPanel").classList.remove("hidden");
    toast(t("pattern.applied"));
  } catch (error) {
    toast(error.message, "error");
    patternSelections = [];
    sourceHoleRef = null;
    fastenerTargetRefs = [];
    renderMateMarkers();
  }
}

function nearestHoleMate(componentId, maximumDistanceMm = 6) {
  const source = component(componentId);
  let best = null;
  for (const sourceHole of holesFor(source)) {
    const sourceRef = { componentId, holeId: sourceHole.id };
    const sourceWorld = holeWorldData(sourceRef);
    if (!sourceWorld) continue;
    for (const target of state.components) {
      if (target.id === componentId || !target.visible || !meshes.has(target.id)) continue;
      for (const targetHole of holesFor(target)) {
        if (!compatibleHoles(sourceHole, targetHole)) continue;
        const targetRef = { componentId: target.id, holeId: targetHole.id };
        const targetWorld = holeWorldData(targetRef);
        for (const [sourceIndex, first] of sourceWorld.openings.entries()) {
          for (const [targetIndex, second] of targetWorld.openings.entries()) {
          const distanceMm = first.distanceTo(second);
          if (distanceMm <= maximumDistanceMm && (!best || distanceMm < best.distanceMm)) {
            best = {
              source: { ...sourceRef, openingSide: sourceIndex ? 1 : -1 },
              target: { ...targetRef, openingSide: targetIndex ? 1 : -1 },
              distanceMm,
            };
          }
          }
        }
      }
    }
  }
  return best;
}

async function applyAutomaticMagnet(componentId) {
  if (!magnetEnabled) return false;
  const candidate = nearestHoleMate(componentId);
  if (!candidate) return false;
  const result = await api("/api/mates/apply", {
    method: "POST",
    body: JSON.stringify({ source: candidate.source, target: candidate.target }),
  });
  state = result.state;
  syncAllMeshes();
  renderComponentList($("#componentSearch").value);
  renderValidation();
  updateRevision();
  toast(t("snap.attached", { label: component(candidate.target.componentId).label }));
  setStatus(t("snap.status", { distance: candidate.distanceMm.toFixed(2) }));
  return true;
}

function updatePointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function beginDirectDrag(event, hit) {
  const id = hit.object.userData.componentId;
  const item = component(id);
  selectComponent(id);
  setTransformMode("translate");
  if (item.locked) {
    toast(t("part.locked"));
    return;
  }
  const joint = jointForComponent(id);
  if (["hinge", "ball", "gear"].includes(joint?.type)) {
    setTransformMode("rotate");
    toast(`${joint.type} constraint: translation is locked`);
    return;
  }
  const mesh = meshes.get(id);
  const planeNormal = camera.getWorldDirection(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, hit.point);
  const startPosition = mesh.position.clone();
  directDrag = {
    id,
    pointerId: event.pointerId,
    plane,
    offset: mesh.position.clone().sub(hit.point),
    startPosition,
    startTransform: jsonTransform(item.transform),
    startY: event.clientY,
    cameraDirection: planeNormal,
    worldPerPixel: camera.position.distanceTo(hit.point) * 1.15 / Math.max(viewport.clientHeight, 1),
    moved: false,
    joint,
    jointAxis: joint ? snapWorldAxis(joint.target) : null,
  };
  transform.detach();
  orbit.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
  renderDragMagnetMarkers(id);
  setStatus(t("drag.help"));
}

function moveDirectDrag(event) {
  if (!directDrag || event.pointerId !== directDrag.pointerId) return;
  const mesh = meshes.get(directDrag.id);
  if (event.shiftKey) {
    const depth = (event.clientY - directDrag.startY) * directDrag.worldPerPixel;
    mesh.position.copy(directDrag.startPosition).addScaledVector(directDrag.cameraDirection, depth);
  } else {
    updatePointerRay(event);
    const point = raycaster.ray.intersectPlane(directDrag.plane, new THREE.Vector3());
    if (point) mesh.position.copy(point.add(directDrag.offset));
  }
  if (directDrag.joint?.type === "slider") {
    const origin = new THREE.Vector3().fromArray(directDrag.joint.originTransform.positionMm);
    const delta = mesh.position.clone().sub(origin);
    let distance = delta.dot(directDrag.jointAxis);
    if (directDrag.joint.minimum != null) distance = Math.max(distance, directDrag.joint.minimum);
    if (directDrag.joint.maximum != null) distance = Math.min(distance, directDrag.joint.maximum);
    mesh.position.copy(origin).addScaledVector(directDrag.jointAxis, distance);
  } else if (directDrag.joint?.type === "limits") {
    const origin = new THREE.Vector3().fromArray(directDrag.joint.originTransform.positionMm);
    const delta = mesh.position.clone().sub(origin);
    const length = delta.length();
    let limited = length;
    if (directDrag.joint.minimum != null) limited = Math.max(limited, directDrag.joint.minimum);
    if (directDrag.joint.maximum != null) limited = Math.min(limited, directDrag.joint.maximum);
    if (length > 1e-6) mesh.position.copy(origin).addScaledVector(delta.normalize(), limited);
  }
  mesh.updateMatrixWorld();
  directDrag.snapCandidate = magnetEnabled ? nearestHoleMate(directDrag.id, 12) : null;
  if (directDrag.snapCandidate) applyLocalHoleSnap(directDrag.snapCandidate);
  previewRigidLinks(directDrag.id, directDrag.startTransform);
  const candidateKey = directDrag.snapCandidate
    ? `${directDrag.snapCandidate.source.holeId}:${directDrag.snapCandidate.source.openingSide}:${directDrag.snapCandidate.target.componentId}:${directDrag.snapCandidate.target.holeId}:${directDrag.snapCandidate.target.openingSide}`
    : "";
  if (candidateKey !== directDrag.candidateKey) {
    directDrag.candidateKey = candidateKey;
    setStatus(directDrag.snapCandidate
      ? t("snap.live", { label: component(directDrag.snapCandidate.target.componentId).label })
      : t("drag.help"));
  }
  updateHoleMarkers(directDrag.id);
  highlightMagnetCandidate(directDrag.snapCandidate);
  directDrag.moved ||= mesh.position.distanceTo(directDrag.startPosition) > 0.05;
  $("#positionX").value = mesh.position.x.toFixed(3);
  $("#positionY").value = mesh.position.y.toFixed(3);
  $("#positionZ").value = mesh.position.z.toFixed(3);
}

async function endDirectDrag(event) {
  if (!directDrag || event.pointerId !== directDrag.pointerId) return;
  const drag = directDrag;
  directDrag = null;
  renderer.domElement.releasePointerCapture(event.pointerId);
  orbit.enabled = true;
  clearHoleMarkers();
  setTransformMode("translate");
  if (!drag.moved) return;
  if (drag.snapCandidate) {
    try {
      const result = await api("/api/mates/apply", {
        method: "POST",
        body: JSON.stringify({ source: drag.snapCandidate.source, target: drag.snapCandidate.target }),
      });
      state = result.state;
      syncAllMeshes();
      renderComponentList($("#componentSearch").value);
      renderValidation();
      updateRevision();
      toast(t("snap.attached", { label: component(drag.snapCandidate.target.componentId).label }));
      setStatus(t("snap.status", { distance: drag.snapCandidate.distanceMm.toFixed(2) }));
      return;
    } catch (error) {
      const mesh = meshes.get(drag.id);
      mesh.position.fromArray(drag.startTransform.positionMm);
      mesh.quaternion.fromArray(drag.startTransform.quaternionXyzw);
      toast(error.message, "error");
      return;
    }
  }
  try {
    await applyOperations([currentTransformOperation(drag.id)]);
  } catch (error) {
    const mesh = meshes.get(drag.id);
    mesh.position.fromArray(drag.startTransform.positionMm);
    mesh.quaternion.fromArray(drag.startTransform.quaternionXyzw);
    toast(error.message, "error");
    return;
  }
  try {
    await applyAutomaticMagnet(drag.id);
  } catch (error) {
    toast(t("drag.snapFailed", { error: error.message }), "error");
  }
}

async function toggleVisibility(id) {
  const item = component(id);
  const visible = !item.visible;
  if (!visible) {
    await applyOperations([{
      type: "visibility", componentId: id, visible: false,
    }], "assembly-presence");
    toast(t("part.removedDone"));
    return;
  }

  const operations = [{ type: "visibility", componentId: id, visible: true }];
  if (!item.locked) {
    const box = new THREE.Box3();
    for (const [meshId, mesh] of meshes) {
      if (meshId !== id && mesh.visible) box.expandByObject(mesh);
    }
    const center = box.isEmpty() ? orbit.target.clone() : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty() ? 40 : box.getBoundingSphere(new THREE.Sphere()).radius;
    const partRadius = new THREE.Vector3().fromArray(item.sizeMm || [20, 20, 20]).length() * .5;
    camera.updateMatrixWorld();
    const screenRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const spawn = center.addScaledVector(screenRight, radius + partRadius + 24);
    operations.push({
      type: "set_transform",
      componentId: id,
      positionMm: spawn.toArray(),
      quaternionXyzw: item.transform.quaternionXyzw,
    });
  }
  const result = await applyOperations(operations, "assembly-presence");
  const addedId = result.affected[0];
  selectComponent(addedId);
  setTransformMode("translate");
  fitView();
  const mesh = meshes.get(addedId);
  if (mesh) {
    mesh.material.emissive.setHex(0x4f5962);
    mesh.material.emissiveIntensity = 1.15;
    window.setTimeout(() => {
      if (selectedId === addedId) {
        mesh.material.emissive.setHex(0x163a50);
        mesh.material.emissiveIntensity = .7;
      }
    }, 900);
  }
  toast(t("part.addedReady", { name: component(addedId).label }));
  setStatus(t("part.moveNow", { name: component(addedId).label }));
}

async function duplicateSelectedComponent() {
  if (!selectedId) return;
  const source = component(selectedId);
  if (!source?.meshUrl || ["fastener", "bearing"].includes(source.kind)) return;
  try {
    const result = await applyOperations([{
      type: "duplicate_component", componentId: selectedId,
    }], "duplicate");
    const instanceId = result.affected[0];
    selectComponent(instanceId);
    setTransformMode("translate");
    toast(t("selection.duplicated", { name: component(instanceId).label }));
  } catch (error) { toast(error.message, "error"); }
}

function requestClearAssembly() {
  const dialog = $("#clearAssemblyDialog");
  if (!dialog.open) dialog.showModal();
}

async function clearAssembly() {
  const toolbarButton = $("#clearAssemblyButton");
  const confirmButton = $("#confirmClearAssembly");
  toolbarButton.disabled = true;
  confirmButton.disabled = true;
  try {
    const result = await api("/api/operations/clear", { method: "POST", body: "{}" });
    state = result.state;
    $("#clearAssemblyDialog").close("confirmed");
    if (mateMode) cancelMateMode();
    lastSnapMate = null;
    $("#snapRotatePanel").classList.add("hidden");
    $("#jointPanel").classList.add("hidden");
    syncAllMeshes();
    renderComponentList($("#componentSearch").value);
    renderValidation();
    updateRevision();
    toast(t("assembly.cleared"));
  } catch (error) { toast(error.message, "error"); }
  finally {
    toolbarButton.disabled = false;
    confirmButton.disabled = false;
  }
}

async function applyOperations(operations, source = "human") {
  const result = await api("/api/operations/apply", {
    method: "POST",
    body: JSON.stringify({ operations, source }),
  });
  state = result.state;
  await reconcileMeshesWithState();
  renderComponentList($("#componentSearch").value);
  renderValidation();
  updateRevision();
  setStatus(t("revision.saved", { revision: state.revision }));
  return result;
}

function positionFromEditor() {
  const values = ["#positionX", "#positionY", "#positionZ"].map((id) => Number($(id).value));
  return values.every(Number.isFinite) ? values : null;
}

function previewPositionFromEditor() {
  if (!selectedId) return;
  const position = positionFromEditor();
  const mesh = meshes.get(selectedId);
  if (!position || !mesh) return;
  mesh.position.fromArray(position);
  mesh.updateMatrixWorld();
  previewRigidLinks(selectedId, component(selectedId).transform);
  if (mateMode) renderMateMarkers();
}

async function commitEditorPosition(
  componentId = selectedId,
  position = positionFromEditor(),
  quaternionXyzw = meshes.get(componentId)?.quaternion.toArray(),
) {
  window.clearTimeout(positionCommitTimer);
  positionCommitTimer = null;
  if (!componentId) return;
  const item = component(componentId);
  if (!position || !item || item.locked || !item.visible) return;
  if (position.every((value, index) => Math.abs(value - item.transform.positionMm[index]) < 1e-9)) return;
  try {
    await applyOperations([{
      type: "set_transform", componentId, positionMm: position,
      quaternionXyzw: quaternionXyzw || item.transform.quaternionXyzw,
    }], "position-editor");
  } catch (error) {
    syncMesh(item);
    toast(error.message, "error");
  }
}

function scheduleEditorPositionCommit() {
  const componentId = selectedId;
  const position = positionFromEditor();
  const quaternionXyzw = meshes.get(componentId)?.quaternion.toArray();
  window.clearTimeout(positionCommitTimer);
  positionCommitTimer = window.setTimeout(
    () => commitEditorPosition(componentId, position, quaternionXyzw),
    280,
  );
}

function currentTransformOperation(id) {
  const mesh = meshes.get(id);
  return {
    type: "set_transform",
    componentId: id,
    positionMm: mesh.position.toArray(),
    quaternionXyzw: mesh.quaternion.toArray(),
  };
}

function updateRevision() {
  $("#revisionBadge").textContent = `rev ${state.revision}`;
  $("#undoButton").disabled = historyBusy || !(state.undoDepth > 0);
  $("#redoButton").disabled = historyBusy || !(state.redoDepth > 0);
}

function normalizedDisplayDegrees(value) {
  const normalized = ((value % 360) + 360) % 360;
  return Math.abs(normalized - 360) < 1e-9 ? 0 : normalized;
}

function updateSnapRotationStatus() {
  if (!lastSnapMate || Array.isArray(lastSnapMate.source)) return;
  $("#snapRotateStatus").textContent = t("rotate.current", {
    snapType: lastSnapMate.snapType,
    degrees: normalizedDisplayDegrees(snapRotationTotal),
    offset: Number(snapOffsetTotal.toFixed(3)),
  });
}

function setSnapRotationBusy(value) {
  snapRotationBusy = value;
  for (const button of document.querySelectorAll(".rotate-snap")) button.disabled = value;
  $("#applySnapAdjustment").disabled = value;
  $("#dismissSnapRotation").disabled = value;
}

async function rotateLastSnap(degrees, offsetMm = 0) {
  if (snapRotationBusy || !lastSnapMate || Array.isArray(lastSnapMate.source)) return;
  setSnapRotationBusy(true);
  try {
    const result = await api("/api/snaps/rotate", {
      method: "POST",
      body: JSON.stringify({ source: lastSnapMate.source, target: lastSnapMate.target, degrees, offsetMm }),
    });
    state = result.state;
    snapRotationTotal += degrees;
    snapOffsetTotal += offsetMm;
    await reconcileMeshesWithState();
    renderComponentList($("#componentSearch").value);
    renderValidation();
    updateRevision();
    updateSnapRotationStatus();
    $("#snapRotatePanel").classList.remove("hidden");
    toast(t("rotate.applied", { degrees }));
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setSnapRotationBusy(false);
  }
}

async function navigateHistory(action) {
  if (historyBusy || !["undo", "redo"].includes(action)) return;
  const depth = action === "undo" ? state.undoDepth : state.redoDepth;
  if (!(depth > 0)) return;
  historyBusy = true;
  updateRevision();
  try {
    state = await api(`/api/operations/${action}`, { method: "POST", body: "{}" });
    const rotationHistory = state.historyAction?.source === "snap-rotation" && lastSnapMate;
    if (rotationHistory) {
      const factor = action === "undo" ? -1 : 1;
      snapRotationTotal += factor * Number(state.historyAction.metadata?.rotation?.degrees || 0);
      snapOffsetTotal += factor * Number(state.historyAction.metadata?.rotation?.offsetMm || 0);
      updateSnapRotationStatus();
      $("#snapRotatePanel").classList.remove("hidden");
    } else {
      lastSnapMate = null;
      $("#snapRotatePanel").classList.add("hidden");
      $("#jointPanel").classList.add("hidden");
    }
    await reconcileMeshesWithState();
    renderComponentList($("#componentSearch").value);
    renderValidation();
    if (selectedId && meshes.has(selectedId)) selectComponent(selectedId);
    if (mateMode) renderMateMarkers();
    toast(t(`${action}.done`));
  } catch (error) {
    toast(error.message, "error");
  } finally {
    historyBusy = false;
    updateRevision();
  }
}

function renderValidation() {
  const exactIsCurrent = state.validation.exact && state.validation.exactRevision === state.revision;
  const collisions = exactIsCurrent
    ? state.validation.exact.collisions
    : state.validation.approximate || [];
  $("#collisionCount").textContent = collisions.length;
  $("#validationMeta").textContent = exactIsCurrent
    ? t("validation.exact", { revision: state.revision })
    : t("validation.approx");
  const list = $("#collisionList");
  list.replaceChildren();
  for (const collision of collisions.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "collision-item";
    const first = collision.firstLabel || collision.first_label || collision.first;
    const second = collision.secondLabel || collision.second_label || collision.second;
    const volume = collision.intersection_volume_mm3 ?? collision.approximateOverlapMm3;
    row.innerHTML = `<span>${escapeHtml(first)} × ${escapeHtml(second)}</span><span class="collision-volume">${Number(volume).toLocaleString(document.documentElement.lang, { maximumFractionDigits: 1 })}</span>`;
    row.addEventListener("click", () => selectComponent(collision.first));
    list.append(row);
  }
}

function clearGhosts() {
  for (const ghost of ghosts.splice(0)) {
    scene.remove(ghost);
    ghost.material.dispose();
  }
}

function showProposalPreview(preview) {
  clearGhosts();
  for (const item of preview.components) {
    const source = meshes.get(item.id);
    if (!source) continue;
    const ghost = new THREE.Mesh(source.geometry, new THREE.MeshStandardMaterial({
      color: 0xffa85c,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      wireframe: false,
    }));
    ghost.position.fromArray(item.transform.positionMm);
    ghost.quaternion.fromArray(item.transform.quaternionXyzw);
    ghost.renderOrder = 5;
    scene.add(ghost);
    ghosts.push(ghost);
  }
}

function appendChat(text, role = "assistant") {
  const message = document.createElement("div");
  message.className = `chat-message ${role}`;
  message.textContent = text;
  $("#chatLog").append(message);
  $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
}

async function requestAiProposal(message) {
  appendChat(message, "user");
  const button = $("#chatForm button");
  setBusy(button, true, "Analyzing…");
  clearGhosts();
  $("#proposalPanel").classList.add("hidden");
  try {
    proposal = await api("/api/ai/propose", {
      method: "POST",
      body: JSON.stringify({ message, selectedId }),
    });
    appendChat(proposal.summary, "assistant");
    $("#proposalSummary").textContent = proposal.summary;
    const operations = $("#proposalOperations");
    operations.replaceChildren();
    for (const operation of proposal.operations) {
      const row = document.createElement("div");
      row.className = "proposal-operation";
      row.textContent = `${operation.componentId}: Δ ${operation.deltaMm.join(", ")} mm · ${operation.rotationDegrees}° ${operation.rotationAxis} — ${operation.rationale}`;
      operations.append(row);
    }
    $("#proposalPanel").classList.remove("hidden");
    showProposalPreview(proposal.preview);
    setStatus(t("ai.previewStatus", { operations: proposal.operations.length, collisions: proposal.preview.collisions.length }));
  } catch (error) {
    appendChat(error.message, "error");
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function exactValidation() {
  const button = $("#exactButton");
  setBusy(button, true, "FreeCAD…");
  setStatus(t("freecad.running"));
  try {
    const result = await api("/api/validate/exact", { method: "POST", body: "{}" });
    state = await api("/api/assembly");
    renderValidation();
    updateRevision();
    toast(t("freecad.complete", { count: result.exact.collisions.length }));
    setStatus(`FreeCAD: ${result.exact.completed_candidate_pairs} coppie controllate, ${result.exact.failed_pairs.length} errori`);
  } catch (error) {
    toast(error.message, "error");
    setStatus(t("freecad.failed"));
  } finally {
    setBusy(button, false);
  }
}

async function exportAssembly(format = "fcstd") {
  const step = format === "step";
  const button = $(step ? "#exportStepButton" : "#exportButton");
  setBusy(button, true, t("export.running"));
  try {
    const result = await api(step ? "/api/export/step" : "/api/export", { method: "POST", body: "{}" });
    const anchor = document.createElement("a");
    anchor.href = step ? result.stepUrl : result.modelUrl;
    anchor.click();
    toast(t("export.ready", { revision: result.revision }));
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

const exportViewDirections = {
  "iso-ne": [1, -1, .8], "iso-nw": [-1, -1, .8],
  "iso-se": [1, 1, .8], "iso-sw": [-1, 1, .8],
  top: [0, 0, 1], bottom: [0, 0, -1],
  front: [-1, 0, 0], rear: [1, 0, 0], left: [0, -1, 0], right: [0, 1, 0],
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportTechnicalView() {
  const button = $("#confirmImageExport");
  setBusy(button, true, t("imageExport.running"));
  const [width, height] = $("#imageExportResolution").value.split("x").map(Number);
  const format = $("#imageExportFormat").value;
  const view = $("#imageExportView").value;
  const clean = $("#imageExportClean").checked;
  const fitWidth = $("#imageExportFitWidth").checked;
  const saved = {
    position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: orbit.target.clone(),
    near: camera.near, far: camera.far, aspect: camera.aspect, pixelRatio: renderer.getPixelRatio(),
    grid: grid.visible, axes: axes.visible, helper: transformHelper.visible,
    markerVisibility: holeMarkers.map((marker) => marker.visible),
    ghostVisibility: ghosts.map((ghost) => ghost.visible),
  };
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const exportDirection = exportViewDirections[view]
      ? new THREE.Vector3(...exportViewDirections[view])
      : camera.position.clone().sub(orbit.target);
    if (fitWidth) fitViewToWidth(exportDirection);
    else if (exportViewDirections[view]) fitView(exportDirection);
    camera.updateProjectionMatrix();
    if (clean) {
      grid.visible = false; axes.visible = false; transformHelper.visible = false;
      holeMarkers.forEach((marker) => { marker.visible = false; });
      ghosts.forEach((ghost) => { ghost.visible = false; });
    }
    renderer.render(scene, camera);
    const pngUrl = renderer.domElement.toDataURL("image/png");
    const stem = `rc-car-${view}-${width}x${height}`;
    if (format === "svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeHtml(t("imageExport.svgTitle"))}</title><image width="${width}" height="${height}" href="${pngUrl}"/></svg>`;
      downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${stem}.svg`);
    } else {
      const response = await fetch(pngUrl);
      downloadBlob(await response.blob(), `${stem}.png`);
    }
    $("#exportImageDialog").close("exported");
    toast(t("imageExport.ready", { view: $("#imageExportView").selectedOptions[0].textContent }));
  } catch (error) {
    toast(t("imageExport.failed", { error: error.message }), "error");
  } finally {
    camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion);
    camera.near = saved.near; camera.far = saved.far; camera.aspect = saved.aspect;
    orbit.target.copy(saved.target);
    grid.visible = saved.grid; axes.visible = saved.axes; transformHelper.visible = saved.helper;
    holeMarkers.forEach((marker, index) => { marker.visible = saved.markerVisibility[index]; });
    ghosts.forEach((ghost, index) => { ghost.visible = saved.ghostVisibility[index]; });
    renderer.setPixelRatio(saved.pixelRatio);
    resize();
    orbit.update(); renderer.render(scene, camera);
    setBusy(button, false);
  }
}

function portableProject() {
  return {
    format: "rc-car-assembly-project",
    version: 1,
    name: state.name || "RC car assembly",
    savedAt: new Date().toISOString(),
    view: { scene: jsonTransform(sceneAppearance) },
    assembly: {
      components: state.components.map((item) => ({
        id: item.id, kind: item.kind, label: item.label,
        transform: jsonTransform(item.transform), visible: item.visible, locked: item.locked,
        color: item.color, appearance: item.appearance || "default", opacity: effectiveOpacity(item), groupId: item.groupId || null,
        ...(item.kind === "instance" ? { instanceOf: item.instanceOf } : {}),
        ...(item.kind === "fastener" ? { fastener: jsonTransform(item.fastener) } : {}),
        ...(item.kind === "bearing" ? { bearing: jsonTransform(item.bearing) } : {}),
        ...(item.kind === "catalog" ? { catalog: jsonTransform(item.catalog) } : {}),
        ...(item.kind === "turnbuckle" ? { turnbuckle: jsonTransform(item.turnbuckle) } : {}),
      })),
      groups: jsonTransform(state.groups || []),
      workspace: jsonTransform(state.workspace || {}),
      mates: jsonTransform(state.mates || []),
      joints: jsonTransform(state.joints || []),
    },
  };
}

function saveProject() {
  const project = portableProject();
  const filename = `${String(project.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "assembly"}.rc-car.json`;
  downloadBlob(new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" }), filename);
  toast(t("project.saved"));
}

async function readProjectFile(file) {
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error(t("project.tooLarge"));
    const project = JSON.parse(await file.text());
    if (project?.format !== "rc-car-assembly-project" || Number(project?.version) !== 1 || !Array.isArray(project?.assembly?.components)) {
      throw new Error(t("project.invalid"));
    }
    pendingProject = project;
    const placed = project.assembly.components.filter((item) => item.visible).length;
    $("#loadProjectSummary").textContent = t("project.summary", {
      name: project.name || file.name, parts: project.assembly.components.length, placed,
    });
    $("#loadProjectDialog").showModal();
  } catch (error) {
    pendingProject = null;
    toast(error.message, "error");
  }
}

async function loadProject() {
  if (!pendingProject) return;
  const button = $("#confirmLoadProject");
  setBusy(button, true, t("project.loading"));
  try {
    const projectScene = pendingProject.view?.scene;
    state = await api("/api/project/load", {
      method: "POST", body: JSON.stringify({ project: pendingProject }),
    });
    pendingProject = null;
    if (projectScene) applySceneAppearance(projectScene);
    selectedId = null;
    cancelMateMode();
    await reconcileMeshesWithState();
    renderComponentList($("#componentSearch").value);
    renderValidation(); updateRevision(); fitView();
    $("#loadProjectDialog").close("loaded");
    toast(t("project.loaded"));
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function writeSceneSettingsControls(settings) {
  $("#scenePreset").value = settings.preset;
  $("#sceneBackgroundColor").value = settings.background;
  $("#sceneBackgroundValue").value = settings.background.toUpperCase();
  $("#sceneGridVisible").checked = settings.grid;
  $("#sceneAxesVisible").checked = settings.axes;
  $("#sceneLightingEnabled").checked = settings.lighting;
  $("#sceneReflectionsEnabled").checked = settings.reflections;
  $("#sceneLightIntensity").value = Math.round(settings.lightIntensity * 100);
  $("#sceneLightIntensityValue").textContent = `${Math.round(settings.lightIntensity * 100)}%`;
  $("#sceneReflectionIntensity").value = Math.round(settings.reflectionIntensity * 100);
  $("#sceneReflectionIntensityValue").textContent = `${Math.round(settings.reflectionIntensity * 100)}%`;
  $("#sceneDarkLift").value = Math.round(settings.darkLift * 100);
  $("#sceneDarkLiftValue").textContent = `${Math.round(settings.darkLift * 100)}%`;
}

function sceneSettingsFromControls() {
  return {
    preset: $("#scenePreset").value,
    background: $("#sceneBackgroundColor").value,
    grid: $("#sceneGridVisible").checked,
    axes: $("#sceneAxesVisible").checked,
    lighting: $("#sceneLightingEnabled").checked,
    reflections: $("#sceneReflectionsEnabled").checked,
    lightIntensity: Number($("#sceneLightIntensity").value) / 100,
    reflectionIntensity: Number($("#sceneReflectionIntensity").value) / 100,
    darkLift: Number($("#sceneDarkLift").value) / 100,
  };
}

function previewSceneSettings(custom = false) {
  if (custom) $("#scenePreset").value = "custom";
  applySceneAppearance(sceneSettingsFromControls(), false);
}

function openSceneSettings() {
  sceneAppearanceBeforeDialog = jsonTransform(sceneAppearance);
  writeSceneSettingsControls(sceneAppearance);
  $("#sceneSettingsDialog").showModal();
}

function saveSceneSettings() {
  const settings = sceneSettingsFromControls();
  sceneAppearanceBeforeDialog = null;
  applySceneAppearance(settings);
  $("#sceneSettingsDialog").close("applied");
  toast(t("scene.saved"));
}

function resetSceneSettings() {
  writeSceneSettingsControls(defaultSceneAppearance);
  previewSceneSettings();
}

function wireEvents() {
  renderLocaleOptions();
  $("#localeSelect").addEventListener("change", async (event) => setLocale(event.target.value));
  $("#importLocaleButton").addEventListener("click", () => $("#localeFileInput").click());
  $("#exportLocaleButton").addEventListener("click", downloadLocaleTemplate);
  $("#localeFileInput").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      const result = await importLocaleFile(file);
      renderLocaleOptions();
      toast(t("i18n.imported", result));
    } catch (error) { toast(t("i18n.importFailed", { error: error.message }), "error"); }
    finally { event.target.value = ""; }
  });
  window.addEventListener("i18n:changed", () => {
    renderLocaleOptions();
    if (Object.keys(bearingCatalog).length) renderBearingCatalog();
    if (rcCatalog.length) renderRcCatalog();
    if (!state) return;
    renderComponentList($("#componentSearch").value);
    if (selectedId) selectComponent(selectedId, false);
    renderValidation();
    syncPlaneMateOptions();
    if (lastSnapMate) updateSnapRotationStatus();
  });
  $("#componentSearch").addEventListener("input", (event) => renderComponentList(event.target.value));
  for (const button of document.querySelectorAll(".presence-filter-button")) {
    button.addEventListener("click", () => {
      componentPresenceFilter = button.dataset.presence;
      for (const candidate of document.querySelectorAll(".presence-filter-button")) {
        candidate.classList.toggle("active", candidate === button);
      }
      renderComponentList($("#componentSearch").value);
    });
  }
  $("#selectMode").addEventListener("click", () => setTransformMode("select"));
  $("#translateMode").addEventListener("click", () => setTransformMode("translate"));
  $("#rotateMode").addEventListener("click", () => setTransformMode("rotate"));
  for (const button of document.querySelectorAll(".quick-axis-button")) {
    button.addEventListener("click", () => {
      quickRotateAxis = button.dataset.axis;
      for (const candidate of document.querySelectorAll(".quick-axis-button")) {
        candidate.classList.toggle("active", candidate === button);
      }
    });
  }
  for (const button of document.querySelectorAll(".quick-rotate")) {
    button.addEventListener("click", () => applyQuickRotation(Number(button.dataset.degrees)));
  }
  $("#mateMode").addEventListener("click", () => mateMode ? cancelMateMode() : startMateMode());
  $("#magnetToggle").addEventListener("click", () => {
    if (mateMode) {
      cancelMateMode();
      setStatus(t("mate.cancelled"));
    } else {
      startMateMode();
    }
  });
  $("#snapFilter").addEventListener("change", () => {
    syncPlaneMateOptions();
    if (mateMode) renderMateMarkers();
  });
  $("#addFastenerFromHole").addEventListener("click", openFastenerDialog);
  $("#confirmFastener").addEventListener("click", insertFastener);
  $("#applyParametricEdit").addEventListener("click", applyParametricEdit);
  $("#resetParametricEdit").addEventListener("click", resetParametricEdit);
  $("#toggleComponentLock").addEventListener("click", toggleSelectedComponentLock);
  $("#libraryButton").addEventListener("click", () => {
    renderRcCatalog();
    $("#libraryDialog").showModal();
  });
  $("#addLibraryComponent").addEventListener("click", insertRcCatalogComponent);
  $("#libraryScale").addEventListener("change", renderRcCatalog);
  $("#libraryCategory").addEventListener("change", renderRcCatalog);
  for (const id of [
    "editFastenerStandard", "editFastenerDiameter", "editFastenerLength", "editFastenerFlip",
    "editBearingInner", "editBearingOuter", "editBearingWidth", "editBearingSealColor",
  ]) $("#" + id).addEventListener("input", previewParametricEdit);
  $("#editBearingClosure").addEventListener("change", () => {
    const colors = { open: "#c69b46", zz: "#c8cdd1", "2rs": "#202326" };
    $("#editBearingSealColor").value = colors[$("#editBearingClosure").value];
    previewParametricEdit();
  });
  $("#editBearingSeries").addEventListener("change", () => {
    const dimensions = bearingCatalog[$("#editBearingSeries").value];
    if (dimensions) {
      $("#editBearingInner").value = dimensions.innerDiameterMm;
      $("#editBearingOuter").value = dimensions.outerDiameterMm;
      $("#editBearingWidth").value = dimensions.widthMm;
    }
    previewParametricEdit();
  });
  $("#addBearingFromAnchor").addEventListener("click", openBearingDialog);
  $("#confirmBearing").addEventListener("click", insertBearing);
  for (const button of document.querySelectorAll(".plane-mode-button")) {
    button.addEventListener("click", () => {
      planeMateMode = button.dataset.planeMode;
      syncPlaneMateOptions();
    });
  }
  $("#patternToggle").addEventListener("click", () => {
    if (!mateMode) startMateMode();
    patternMode = !patternMode;
    throughMode = false;
    throughSelections = [];
    turnbuckleMode = false;
    turnbuckleSelections = [];
    patternSelections = [];
    sourceHoleRef = null;
    fastenerTargetRefs = [];
    $("#patternToggle").classList.toggle("active", patternMode);
    $("#throughToggle").classList.remove("active");
    $("#turnbuckleToggle").classList.remove("active");
    if (patternMode) {
      $("#snapFilter").value = "hole";
      syncPlaneMateOptions();
      $("#mateStatus").textContent = t("pattern.pick1");
    } else {
      $("#mateStatus").textContent = t("mate.pickFirst");
    }
    renderMateMarkers();
  });
  $("#throughToggle").addEventListener("click", () => {
    if (!mateMode) startMateMode();
    throughMode = !throughMode;
    throughSelections = [];
    patternMode = false;
    patternSelections = [];
    turnbuckleMode = false;
    turnbuckleSelections = [];
    sourceHoleRef = null;
    fastenerTargetRefs = [];
    $("#throughToggle").classList.toggle("active", throughMode);
    $("#patternToggle").classList.remove("active");
    $("#turnbuckleToggle").classList.remove("active");
    if (throughMode) {
      $("#snapFilter").value = "shaft";
      syncPlaneMateOptions();
      $("#mateStatus").textContent = t("through.pickShaft");
    } else {
      $("#mateStatus").textContent = t("mate.pickFirst");
    }
    renderMateMarkers();
  });
  $("#turnbuckleToggle").addEventListener("click", () => {
    if (!mateMode) startMateMode();
    turnbuckleMode = !turnbuckleMode;
    turnbuckleSelections = [];
    patternMode = false;
    patternSelections = [];
    throughMode = false;
    throughSelections = [];
    sourceHoleRef = null;
    fastenerTargetRefs = [];
    $("#turnbuckleToggle").classList.toggle("active", turnbuckleMode);
    $("#patternToggle").classList.remove("active");
    $("#throughToggle").classList.remove("active");
    if (turnbuckleMode) {
      $("#snapFilter").value = "hole";
      syncPlaneMateOptions();
      $("#mateStatus").textContent = t("turnbuckle.pickFirst");
    } else $("#mateStatus").textContent = t("mate.pickFirst");
    renderMateMarkers();
  });
  $("#fitView").addEventListener("click", () => fitView());
  $("#viewIso").addEventListener("click", () => fitView(new THREE.Vector3(1, -1, .75)));
  $("#viewTop").addEventListener("click", () => fitView(new THREE.Vector3(0, 0, 1)));
  $("#viewFront").addEventListener("click", () => fitView(new THREE.Vector3(-1, 0, .05)));
  $("#sceneSettingsButton").addEventListener("click", openSceneSettings);
  $("#bearingSeries").addEventListener("change", syncBearingDimensions);
  $("#bearingClosure").addEventListener("change", syncBearingClosureColor);
  $("#scenePreset").addEventListener("change", (event) => {
    const preset = scenePresetSettings[event.target.value];
    if (!preset) return;
    writeSceneSettingsControls({
      ...sceneSettingsFromControls(), ...preset, preset: event.target.value,
    });
    previewSceneSettings();
  });
  $("#sceneBackgroundColor").addEventListener("input", (event) => {
    $("#scenePreset").value = "custom";
    $("#sceneBackgroundValue").value = event.target.value.toUpperCase();
    previewSceneSettings();
  });
  $("#sceneLightIntensity").addEventListener("input", (event) => {
    $("#sceneLightIntensityValue").textContent = `${event.target.value}%`;
    previewSceneSettings(true);
  });
  $("#sceneReflectionIntensity").addEventListener("input", (event) => {
    $("#sceneReflectionIntensityValue").textContent = `${event.target.value}%`;
    previewSceneSettings(true);
  });
  $("#sceneDarkLift").addEventListener("input", (event) => {
    $("#sceneDarkLiftValue").textContent = `${event.target.value}%`;
    previewSceneSettings(true);
  });
  for (const id of ["#sceneGridVisible", "#sceneAxesVisible", "#sceneLightingEnabled", "#sceneReflectionsEnabled"]) {
    $(id).addEventListener("change", () => previewSceneSettings(true));
  }
  $("#resetSceneSettings").addEventListener("click", resetSceneSettings);
  $("#applySceneSettings").addEventListener("click", saveSceneSettings);
  $("#sceneSettingsDialog").addEventListener("close", () => {
    if (!sceneAppearanceBeforeDialog) return;
    applySceneAppearance(sceneAppearanceBeforeDialog, false);
    sceneAppearanceBeforeDialog = null;
  });
  $("#undoButton").addEventListener("click", () => navigateHistory("undo"));
  $("#redoButton").addEventListener("click", () => navigateHistory("redo"));
  $("#clearAssemblyButton").addEventListener("click", requestClearAssembly);
  $("#confirmClearAssembly").addEventListener("click", clearAssembly);
  $("#revealComponent").addEventListener("click", () => revealSelectedComponent(true));
  $("#newGroupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#newGroupName");
    const name = input.value.trim();
    if (!name) return;
    try {
      await applyOperations([{ type: "create_group", name }], "grouping");
      input.value = "";
      toast(t("groups.created"));
    } catch (error) { toast(error.message, "error"); }
  });
  $("#saveComponentProperties").addEventListener("click", async () => {
    if (!selectedId) return;
    const item = component(selectedId);
    const name = $("#componentName").value.trim();
    const groupId = $("#componentGroup").value || null;
    const operations = [];
    if (name && name !== item.label) operations.push({ type: "rename_component", componentId: selectedId, name });
    if (groupId !== (item.groupId || null)) operations.push({ type: "assign_group", componentId: selectedId, groupId });
    if (!operations.length) return;
    try {
      await applyOperations(operations, "grouping");
      toast(t("selection.detailsSaved"));
    } catch (error) { toast(error.message, "error"); }
  });
  $("#approxButton").addEventListener("click", async () => {
    try {
      const result = await api("/api/validate/approximate", { method: "POST", body: "{}" });
      state.validation.approximate = result.collisions;
      renderValidation();
      toast(t("quick.overlaps", { count: result.collisions.length }));
    } catch (error) { toast(error.message, "error"); }
  });
  $("#exactButton").addEventListener("click", exactValidation);
  $("#exportButton").addEventListener("click", () => exportAssembly("fcstd"));
  $("#exportStepButton").addEventListener("click", () => exportAssembly("step"));
  $("#exportImageButton").addEventListener("click", () => $("#exportImageDialog").showModal());
  $("#confirmImageExport").addEventListener("click", exportTechnicalView);
  $("#saveProjectButton").addEventListener("click", saveProject);
  $("#loadProjectButton").addEventListener("click", () => $("#projectFileInput").click());
  $("#projectFileInput").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) readProjectFile(file);
    event.target.value = "";
  });
  $("#confirmLoadProject").addEventListener("click", loadProject);
  $("#duplicateComponent").addEventListener("click", duplicateSelectedComponent);
  for (const input of document.querySelectorAll("#positionX, #positionY, #positionZ")) {
    input.addEventListener("input", () => {
      previewPositionFromEditor();
      scheduleEditorPositionCommit();
    });
    input.addEventListener("blur", () => {
      if (positionCommitTimer) commitEditorPosition();
    });
  }
  $("#applyTransform").addEventListener("click", () => commitEditorPosition());
  $("#resetComponent").addEventListener("click", async () => {
    if (!selectedId) return;
    const item = component(selectedId);
    try {
      await applyOperations([{
        type: "set_transform",
        componentId: selectedId,
        positionMm: item.baseTransform?.positionMm || item.baseBoundsMm.center,
        quaternionXyzw: item.baseTransform?.quaternionXyzw || [0, 0, 0, 1],
      }]);
    } catch (error) { toast(error.message, "error"); }
  });
  $("#partColor").addEventListener("input", (event) => {
    if (!selectedId) return;
    const color = event.target.value.toLowerCase();
    $("#partColorValue").value = color.toUpperCase();
    meshes.get(selectedId)?.material.color.set(color);
  });
  $("#partColor").addEventListener("change", async (event) => {
    if (!selectedId) return;
    const componentId = selectedId;
    const color = event.target.value.toLowerCase();
    if (component(componentId).color === color) return;
    try {
      await applyOperations([{ type: "color", componentId, color }], "appearance");
      toast(t("part.colorSaved"));
    } catch (error) {
      syncMesh(component(componentId));
      toast(error.message, "error");
    }
  });
  $("#partMaterial").addEventListener("change", async (event) => {
    if (!selectedId) return;
    const componentId = selectedId;
    const appearance = event.target.value;
    const suggestedColors = {
      aluminum: "#b9bec3", steel: "#858d94", carbon: "#24282c",
      bronze: "#9b6837", copper: "#b86b43", rubber: "#202326",
    };
    try {
      const operations = [{ type: "material", componentId, appearance }];
      if (suggestedColors[appearance]) {
        operations.push({ type: "color", componentId, color: suggestedColors[appearance] });
        $("#partColor").value = suggestedColors[appearance];
        $("#partColorValue").value = suggestedColors[appearance].toUpperCase();
      }
      await applyOperations(operations, "appearance");
      toast(t("material.saved"));
    } catch (error) {
      syncMesh(component(componentId));
      toast(error.message, "error");
    }
  });
  $("#partOpacity").addEventListener("input", (event) => {
    if (!selectedId) return;
    const opacity = Number(event.target.value) / 100;
    $("#partOpacityValue").value = `${event.target.value}%`;
    const material = meshes.get(selectedId)?.material;
    if (material) {
      material.opacity = opacity;
      material.transparent = opacity < .999;
      material.depthWrite = opacity >= .999;
      material.needsUpdate = true;
    }
  });
  $("#partOpacity").addEventListener("change", async (event) => {
    if (!selectedId) return;
    const componentId = selectedId;
    const opacity = Number(event.target.value) / 100;
    try {
      await applyOperations([{ type: "opacity", componentId, opacity }], "appearance");
      toast(t("part.opacitySaved"));
    } catch (error) {
      syncMesh(component(componentId));
      toast(error.message, "error");
    }
  });
  $("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chatInput");
    if (input.value.trim()) {
      requestAiProposal(input.value.trim());
      input.value = "";
    }
  });
  $("#applyProposal").addEventListener("click", async () => {
    if (!proposal) return;
    try {
      await applyOperations(proposal.operations, "ai-approved");
      clearGhosts();
      $("#proposalPanel").classList.add("hidden");
      proposal = null;
      toast(t("ai.applied"));
    } catch (error) { toast(error.message, "error"); }
  });
  $("#discardProposal").addEventListener("click", () => {
    proposal = null;
    clearGhosts();
    $("#proposalPanel").classList.add("hidden");
    setStatus(t("ai.discarded"));
  });
  $("#cancelMate").addEventListener("click", () => {
    cancelMateMode();
    setStatus(t("mate.cancelled"));
  });
  for (const button of document.querySelectorAll(".rotate-snap")) {
    button.addEventListener("click", () => rotateLastSnap(Number(button.dataset.degrees)));
  }
  $("#dismissSnapRotation").addEventListener("click", () => {
    $("#snapRotatePanel").classList.add("hidden");
  });
  $("#applySnapAdjustment").addEventListener("click", async () => {
    if (!lastSnapMate || Array.isArray(lastSnapMate.source)) return;
    const degrees = Number($("#customSnapAngle").value);
    const offsetMm = Number($("#customSnapOffset").value);
    await rotateLastSnap(degrees, offsetMm);
  });
  $("#saveJoint").addEventListener("click", async () => {
    if (!lastSnapMate) return;
    const button = $("#saveJoint");
    setBusy(button, true, "Saving…");
    try {
      const result = await api("/api/joints/apply", {
        method: "POST",
        body: JSON.stringify({
          source: lastSnapMate.source,
          target: lastSnapMate.target,
          jointType: $("#jointType").value,
          minimum: $("#jointMinimum").value,
          maximum: $("#jointMaximum").value,
          ratio: $("#jointRatio").value,
        }),
      });
      state = result.state;
      syncAllMeshes(); renderComponentList($("#componentSearch").value); updateRevision();
      $("#jointPanel").classList.add("hidden");
      toast(t("joint.saved", { type: result.joint.type }));
    } catch (error) { toast(error.message, "error"); }
    finally { setBusy(button, false); }
  });
  $("#dismissJoint").addEventListener("click", () => {
    $("#jointPanel").classList.add("hidden");
  });
  $("#applyMate").addEventListener("click", async () => {
    if (!pendingMate) return;
    const button = $("#applyMate");
    setBusy(button, true, "Applying…");
    try {
      const result = await api("/api/mates/apply", {
        method: "POST",
        body: JSON.stringify({ source: pendingMate.source, target: pendingMate.target }),
      });
      state = result.state;
      const movedComponentId = result.mate.source.componentId;
      cancelMateMode();
      selectedId = null;
      syncAllMeshes();
      selectComponent(movedComponentId);
      setTransformMode("translate");
      renderComponentList($("#componentSearch").value);
      renderValidation();
      updateRevision();
      toast(t("mate.applied"));
      setStatus(t("mate.saved", { revision: state.revision }));
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  // Capture before OrbitControls: pressing geometry grabs the part while
  // pressing empty space keeps the normal orbit interaction.
  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (mateMode || transform.dragging || transform.axis) return;
    updatePointerRay(event);
    const hits = raycaster.intersectObjects([...meshes.values()].filter((mesh) => mesh.visible), false);
    if (!hits.length) {
      transform.detach();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    beginDirectDrag(event, hits[0]);
  }, true);
  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (!mateMode) return;
    updatePointerRay(event);
    const markerHits = raycaster.intersectObjects(holeMarkers, false);
    const frontHit = markerHits[0];
    if (frontHit) {
      event.preventDefault();
      event.stopImmediatePropagation();
      chooseHoleMarker(frontHit.object, event.shiftKey || event.ctrlKey || event.metaKey);
      return;
    }
    const solidHit = raycaster.intersectObjects(
      [...meshes.values()].filter((mesh) => mesh.visible), false,
    )[0];
    if (!solidHit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const componentId = solidHit.object.userData.componentId;
    if (!componentId) return;
    setSnapComponentFocus(componentId, event.shiftKey);
    selectComponent(componentId);
  }, true);
  renderer.domElement.addEventListener("pointermove", moveDirectDrag, true);
  renderer.domElement.addEventListener("pointerup", endDirectDrag, true);
  renderer.domElement.addEventListener("pointercancel", endDirectDrag, true);
  transform.addEventListener("dragging-changed", (event) => { orbit.enabled = !event.value; });
  transform.addEventListener("mouseDown", () => {
    if (selectedId) {
      dragStartTransform = jsonTransform(component(selectedId).transform);
      transformSnapCandidate = null;
      renderDragMagnetMarkers(selectedId);
    }
  });
  transform.addEventListener("objectChange", () => {
    if (!selectedId || applyingTransformSnap) return;
    const mesh = meshes.get(selectedId);
    mesh.updateMatrixWorld();
    transformSnapCandidate = magnetEnabled ? nearestHoleMate(selectedId, 12) : null;
    if (transformSnapCandidate) {
      applyingTransformSnap = true;
      applyLocalHoleSnap(transformSnapCandidate);
      applyingTransformSnap = false;
    }
    if (dragStartTransform) previewRigidLinks(selectedId, dragStartTransform);
    updateHoleMarkers(selectedId);
    highlightMagnetCandidate(transformSnapCandidate);
    $("#positionX").value = mesh.position.x.toFixed(3);
    $("#positionY").value = mesh.position.y.toFixed(3);
    $("#positionZ").value = mesh.position.z.toFixed(3);
  });
  transform.addEventListener("mouseUp", async () => {
    if (!selectedId) return;
    clearHoleMarkers();
    try {
      const operations = [currentTransformOperation(selectedId)];
      const joint = jointForComponent(selectedId);
      if (joint?.type === "gear") {
        const targetRef = Array.isArray(joint.target) ? joint.target[0] : joint.target;
        const targetMesh = meshes.get(targetRef?.componentId);
        if (targetMesh && !component(targetRef.componentId).locked) {
          const startQuaternion = new THREE.Quaternion().fromArray(dragStartTransform.quaternionXyzw);
          const delta = meshes.get(selectedId).quaternion.clone().multiply(startQuaternion.invert()).normalize();
          let angle = 2 * Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1));
          if (angle > Math.PI) angle -= Math.PI * 2;
          const linkedRotation = new THREE.Quaternion().setFromAxisAngle(
            snapWorldAxis(joint.target),
            -angle * (joint.ratio || 1),
          );
          targetMesh.quaternion.premultiply(linkedRotation).normalize();
          operations.push(currentTransformOperation(targetRef.componentId));
        }
      }
      await applyOperations(operations);
    } catch (error) {
      const mesh = meshes.get(selectedId);
      mesh.position.fromArray(dragStartTransform.positionMm);
      mesh.quaternion.fromArray(dragStartTransform.quaternionXyzw);
      toast(error.message, "error");
      return;
    }
    try {
      await applyAutomaticMagnet(selectedId);
    } catch (error) {
      toast(t("drag.snapFailed", { error: error.message }), "error");
    }
  });
  window.addEventListener("keydown", (event) => {
    if ($("#clearAssemblyDialog").open || $("#fastenerDialog").open || $("#bearingDialog").open
      || $("#libraryDialog").open || $("#exportImageDialog").open || $("#loadProjectDialog").open
      || $("#sceneSettingsDialog").open) return;
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (event.key === "Delete" && selectedId && component(selectedId).visible) {
      event.preventDefault();
      toggleVisibility(selectedId).catch((error) => toast(error.message, "error"));
      return;
    }
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      navigateHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (commandKey && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      navigateHistory("redo");
      return;
    }
    if (commandKey && !event.altKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelectedComponent();
      return;
    }
    if (event.key.toLowerCase() === "w") setTransformMode("translate");
    if (event.key.toLowerCase() === "e") setTransformMode("rotate");
    if (event.key.toLowerCase() === "m") mateMode ? cancelMateMode() : startMateMode();
    if (event.key === "Escape") mateMode ? cancelMateMode() : setTransformMode("select");
  });
  window.addEventListener("resize", resize);
}

function jsonTransform(value) {
  return JSON.parse(JSON.stringify(value));
}

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
  renderViewCube();
}

async function init() {
  wireEvents();
  resize();
  animate();
  try {
    const [assembly, health, bearings, catalog] = await Promise.all([
      api("/api/assembly"), api("/api/health"), api("/api/catalog/bearings"), api("/api/catalog/rc"),
    ]);
    state = assembly;
    bearingCatalog = bearings;
    rcCatalog = catalog;
    renderBearingCatalog();
    renderRcCatalog();
    $("#aiBadge").textContent = health.aiConfigured ? `AI ${health.model}` : t("health.aiManual");
    $("#aiBadge").className = `badge ${health.aiConfigured ? "ok" : "warn"}`;
    $("#freecadBadge").textContent = health.freecadConfigured ? t("health.freecadReady") : t("health.freecadMissing");
    $("#freecadBadge").className = `badge ${health.freecadConfigured ? "ok" : "warn"}`;
    $("#componentCount").textContent = state.components.length;
    updateRevision();
    renderComponentList();
    renderValidation();
    const placedComponents = state.components.filter((item) => item.visible);
    const loadResult = await loadComponentsProgressively(placedComponents);
    if (loadResult.loaded && !loadResult.sceneRevealed) fitView();
    setStatus(
      t("loading.complete", {
        loaded: loadResult.loaded,
        errors: loadResult.failed ? ` · ${loadResult.failed} errors` : "",
      }),
    );
  } catch (error) {
    $("#loadingOverlay strong").textContent = t("loading.impossible");
    $("#loadingProgress").textContent = error.message;
    toast(error.message, "error");
  }
}

init();
