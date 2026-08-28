#!/usr/bin/env python3
"""Export exact final component solids from an FCStd document as STEP files."""

from __future__ import annotations

import csv
import gc
import json
import re
import sys
from pathlib import Path

import FreeCAD as App


EXPORT_TYPES = {
    "PartDesign::Body",
    "Part::Feature",
    "Part::FeaturePython",
    "Part::MultiFuse",
    "Part::Fillet",
}


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", value.strip()).strip("._")
    return cleaned or "component"


def direct_group(obj) -> str:
    groups = [parent for parent in obj.InList if parent.TypeId == "App::DocumentObjectGroup"]
    return slug(groups[0].Label) if groups else "ungrouped"


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) != 2:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass MODEL.FCStd OUTPUT_DIR")

    model_path = Path(passed[0]).expanduser().resolve()
    output_dir = Path(passed[1]).expanduser().resolve()
    step_root = output_dir / "step"
    step_root.mkdir(parents=True, exist_ok=True)

    doc = App.openDocument(str(model_path))
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

    exported = []
    failures = []
    for index, obj in enumerate(candidates, 1):
        group = direct_group(obj)
        folder = step_root / group
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{slug(obj.Label)}__{obj.Name}.step"
        try:
            obj.Shape.exportStep(str(path))
            box = obj.Shape.BoundBox
            exported.append(
                {
                    "name": obj.Name,
                    "label": obj.Label,
                    "group": group,
                    "step": path.relative_to(output_dir).as_posix(),
                    "size_mm": [round(box.XLength, 6), round(box.YLength, 6), round(box.ZLength, 6)],
                }
            )
        except Exception as exc:
            failures.append({"name": obj.Name, "label": obj.Label, "error": str(exc)})
        gc.collect()
        print(f"[{index}/{len(candidates)}] {obj.Label}", flush=True)

    payload = {"source": str(model_path), "components": exported, "failures": failures}
    (output_dir / "step_manifest.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    with (output_dir / "step_manifest.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["group", "label", "name", "step", "size_x_mm", "size_y_mm", "size_z_mm"])
        for item in exported:
            writer.writerow([item["group"], item["label"], item["name"], item["step"], *item["size_mm"]])

    App.closeDocument(doc.Name)
    print(f"Exported {len(exported)} components; failures: {len(failures)}")


main()
