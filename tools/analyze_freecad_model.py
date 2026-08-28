#!/usr/bin/env python3
"""Extract a read-only inventory from a FreeCAD document.

Run with FreeCADCmd, not the system Python:
    freecadcmd tools/analyze_freecad_model.py --pass MODEL.FCStd OUTPUT_DIR
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

import FreeCAD as App


COMPONENT_TYPES = {
    "App::Part",
    "App::Link",
    "Part::Feature",
    "Part::FeaturePython",
    "PartDesign::Body",
}


def vector_data(vector):
    return [round(float(vector.x), 6), round(float(vector.y), 6), round(float(vector.z), 6)]


def placement_data(placement):
    quaternion = placement.Rotation.Q
    return {
        "base_mm": vector_data(placement.Base),
        "quaternion_xyzw": [round(float(value), 9) for value in quaternion],
        "angle_deg": round(float(placement.Rotation.Angle) * 180.0 / 3.141592653589793, 6),
        "axis": vector_data(placement.Rotation.Axis),
    }


def shape_data(obj):
    if not hasattr(obj, "Shape"):
        return None
    try:
        shape = obj.Shape
        if shape.isNull():
            return None
        box = shape.BoundBox
        return {
            "solid_count": len(shape.Solids),
            "shell_count": len(shape.Shells),
            "face_count": len(shape.Faces),
            "edge_count": len(shape.Edges),
            "volume_mm3": round(float(shape.Volume), 6),
            "area_mm2": round(float(shape.Area), 6),
            "center_of_mass_mm": vector_data(shape.CenterOfMass),
            "bounds_mm": {
                "min": [round(box.XMin, 6), round(box.YMin, 6), round(box.ZMin, 6)],
                "max": [round(box.XMax, 6), round(box.YMax, 6), round(box.ZMax, 6)],
                "size": [round(box.XLength, 6), round(box.YLength, 6), round(box.ZLength, 6)],
            },
        }
    except Exception as exc:
        return {"error": str(exc)}


def property_value(obj, name, default=None):
    try:
        return getattr(obj, name)
    except Exception:
        return default


def main():
    args = list(sys.argv)
    try:
        pass_index = args.index("--pass")
        passed = args[pass_index + 1 :]
    except ValueError:
        passed = sys.argv[1:]

    if len(passed) != 2:
        raise SystemExit("Uso: freecadcmd SCRIPT --pass MODEL.FCStd OUTPUT_DIR")

    model_path = Path(passed[0]).expanduser().resolve()
    output_dir = Path(passed[1]).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    doc = App.openDocument(str(model_path))
    if doc is None:
        raise RuntimeError(f"Impossibile aprire {model_path}")

    objects = []
    for obj in doc.Objects:
        placement = property_value(obj, "Placement")
        entry = {
            "name": obj.Name,
            "label": obj.Label,
            "type_id": obj.TypeId,
            "state": [str(value) for value in property_value(obj, "State", [])],
            "placement": placement_data(placement) if placement is not None else None,
            "shape": shape_data(obj),
            "parents": [parent.Name for parent in obj.InList],
            "children": [child.Name for child in obj.OutList],
        }
        if hasattr(obj, "Group"):
            entry["group_members"] = [member.Name for member in obj.Group]
        objects.append(entry)

    by_name = {entry["name"]: entry for entry in objects}
    components = [entry for entry in objects if entry["type_id"] in COMPONENT_TYPES and entry["shape"]]
    groups = [entry for entry in objects if entry["type_id"] == "App::DocumentObjectGroup"]

    report = {
        "source": str(model_path),
        "document_label": doc.Label,
        "freecad_version": ".".join(str(value) for value in App.Version()[:3]),
        "object_count": len(objects),
        "component_count": len(components),
        "type_counts": dict(sorted(Counter(entry["type_id"] for entry in objects).items())),
        "objects": objects,
    }
    (output_dir / "model_inventory.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    with (output_dir / "components.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["name", "label", "type", "size_x_mm", "size_y_mm", "size_z_mm", "volume_mm3", "parents"]
        )
        for entry in sorted(components, key=lambda item: (item["label"].lower(), item["name"])):
            shape = entry["shape"]
            size = shape.get("bounds_mm", {}).get("size", ["", "", ""])
            writer.writerow(
                [
                    entry["name"],
                    entry["label"],
                    entry["type_id"],
                    *size,
                    shape.get("volume_mm3", ""),
                    " | ".join(entry["parents"]),
                ]
            )

    lines = [
        f"# Inventario assieme: {doc.Label}",
        "",
        f"- Oggetti FreeCAD: {len(objects)}",
        f"- Componenti geometrici candidati: {len(components)}",
        f"- Gruppi: {len(groups)}",
        "",
        "## Gruppi e membri diretti",
        "",
    ]
    for group in sorted(groups, key=lambda item: item["label"].lower()):
        lines.append(f"### {group['label']} (`{group['name']}`)")
        lines.append("")
        for member_name in group.get("group_members", []):
            member = by_name.get(member_name, {})
            lines.append(
                f"- {member.get('label', member_name)} (`{member_name}`, {member.get('type_id', 'tipo ignoto')})"
            )
        if not group.get("group_members"):
            lines.append("- Gruppo vuoto")
        lines.append("")

    (output_dir / "assembly_groups.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"Analisi completata: {len(objects)} oggetti, {len(components)} componenti geometrici")
    print(f"Risultati: {output_dir}")
    App.closeDocument(doc.Name)


# FreeCADCmd 1.1.x imports the supplied file as a module, so __name__ is not
# "__main__". This analyzer is intentionally a command-line entry point.
main()
