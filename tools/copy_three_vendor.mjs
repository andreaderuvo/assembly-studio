import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const destination = path.resolve("webapp/public/vendor");
await mkdir(destination, { recursive: true });

const files = [
  ["node_modules/three/build/three.module.js", "three.module.js"],
  ["node_modules/three/build/three.core.js", "three.core.js"],
  ["node_modules/three/examples/jsm/controls/OrbitControls.js", "OrbitControls.js"],
  ["node_modules/three/examples/jsm/controls/TransformControls.js", "TransformControls.js"],
  ["node_modules/three/examples/jsm/loaders/STLLoader.js", "STLLoader.js"],
];

for (const [source, name] of files) {
  await copyFile(path.resolve(source), path.join(destination, name));
}

console.log(`Vendored ${files.length} Three.js modules`);
