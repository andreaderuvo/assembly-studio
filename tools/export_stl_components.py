#!/usr/bin/env python3
"""Export final component bodies from an FCStd document as lightweight STL files.

Run with FreeCADCmd:
    freecadcmd tools/export_stl_components.py --pass MODEL.FCStd OUTPUT_DIR

The document is opened without recomputing it.  Each mesh is released before the
next component is processed, keeping peak memory substantially lower than a GUI
render of the complete model.
"""

from __future__ import annotations

import csv
import gc
import json
import math
import re
import sys
from pathlib import Path

import FreeCAD as App
import MeshPart


EXPORT_TYPES = {
    "PartDesign::Body",
    "PartDesign::Feature",
    "Part::Feature",
    "Part::FeaturePython",
    "Part::MultiFuse",
    "Part::Fillet",
}
LINEAR_DEFLECTION_MM = 0.20
ANGULAR_DEFLECTION_RAD = math.radians(20.0)


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", value.strip()).strip("._")
    return cleaned or "component"


def direct_group(obj) -> str:
    groups = [parent for parent in obj.InList if parent.TypeId == "App::DocumentObjectGroup"]
    if not groups:
        return "ungrouped"
    return slug(groups[0].Label)


def vector(value):
    return [round(float(value.x), 6), round(float(value.y), 6), round(float(value.z), 6)]


def main():
    args = list(sys.argv)
    try:
        pass_index = args.index("--pass")
        passed = args[pass_index + 1 :]
    except ValueError:
        passed = args[1:]

    if len(passed) != 2:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass MODEL.FCStd OUTPUT_DIR")

    model_path = Path(passed[0]).expanduser().resolve()
    output_dir = Path(passed[1]).expanduser().resolve()
    stl_root = output_dir / "stl"
    stl_root.mkdir(parents=True, exist_ok=True)

    doc = App.openDocument(str(model_path))
    if doc is None:
        raise RuntimeError(f"Cannot open {model_path}")

    candidates = []
    for obj in doc.Objects:
        if obj.TypeId not in EXPORT_TYPES or not hasattr(obj, "Shape"):
            continue
        try:
            if obj.Shape.isNull() or not obj.Shape.Solids:
                continue
        except Exception:
            continue
        candidates.append(obj)

    manifest = []
    failures = []
    for index, obj in enumerate(candidates, 1):
        group = direct_group(obj)
        group_dir = stl_root / group
        group_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{slug(obj.Label)}__{obj.Name}.stl"
        path = group_dir / filename
        try:
            mesh = MeshPart.meshFromShape(
                Shape=obj.Shape,
                LinearDeflection=LINEAR_DEFLECTION_MM,
                AngularDeflection=ANGULAR_DEFLECTION_RAD,
                Relative=False,
            )
            mesh.write(str(path))
            box = obj.Shape.BoundBox
            rotation = obj.Placement.Rotation
            manifest.append(
                {
                    "name": obj.Name,
                    "label": obj.Label,
                    "type": obj.TypeId,
                    "group": group,
                    "stl": path.relative_to(output_dir).as_posix(),
                    "triangles": int(mesh.CountFacets),
                    "size_mm": [round(box.XLength, 6), round(box.YLength, 6), round(box.ZLength, 6)],
                    "bounds_mm": {
                        "min": [round(box.XMin, 6), round(box.YMin, 6), round(box.ZMin, 6)],
                        "max": [round(box.XMax, 6), round(box.YMax, 6), round(box.ZMax, 6)],
                        "center": [
                            round((box.XMin + box.XMax) / 2.0, 6),
                            round((box.YMin + box.YMax) / 2.0, 6),
                            round((box.ZMin + box.ZMax) / 2.0, 6),
                        ],
                    },
                    "placement_mm": vector(obj.Placement.Base),
                    "rotation_axis": vector(rotation.Axis),
                    "rotation_deg": round(math.degrees(float(rotation.Angle)), 6),
                }
            )
            del mesh
        except Exception as exc:
            failures.append({"name": obj.Name, "label": obj.Label, "error": str(exc)})
        gc.collect()
        print(f"[{index}/{len(candidates)}] {obj.Label}", flush=True)

    (output_dir / "stl_manifest.json").write_text(
        json.dumps(
            {
                "source": str(model_path),
                "linear_deflection_mm": LINEAR_DEFLECTION_MM,
                "angular_deflection_deg": math.degrees(ANGULAR_DEFLECTION_RAD),
                "components": manifest,
                "failures": failures,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    with (output_dir / "stl_manifest.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["group", "label", "name", "stl", "triangles", "size_x_mm", "size_y_mm", "size_z_mm"])
        for item in manifest:
            writer.writerow(
                [item["group"], item["label"], item["name"], item["stl"], item["triangles"], *item["size_mm"]]
            )

    App.closeDocument(doc.Name)
    print(f"Exported {len(manifest)} components; failures: {len(failures)}")


main()
