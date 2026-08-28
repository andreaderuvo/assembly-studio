#!/usr/bin/env python3
"""Create the persistent web-assembly state from exported STL metadata."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


COLORS = {
    "exact-source-joint": "#8ea4b8",
    "provisional-authored-placement": "#f1b45b",
    "user-guided-above-lipo-divider": "#e5c46c",
    "user-guided-above-rear-right-shoulder": "#e5c46c",
}


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.replace(temporary, path)


def main() -> None:
    if len(sys.argv) not in (5, 6):
        raise SystemExit(
            "Usage: prepare_web_assembly.py ASSEMBLY.json STL_MANIFEST.json "
            "COLLISIONS.json [HOLE_INTERFACES.json] OUTPUT.json"
        )

    paths = list(map(lambda value: Path(value).resolve(), sys.argv[1:]))
    assembly_path, mesh_path, collisions_path = paths[:3]
    interfaces_path = paths[3] if len(paths) == 5 else None
    output_path = paths[-1]
    assembly = json.loads(assembly_path.read_text(encoding="utf-8"))
    mesh_manifest = json.loads(mesh_path.read_text(encoding="utf-8"))
    collisions = json.loads(collisions_path.read_text(encoding="utf-8"))
    interfaces = (
        json.loads(interfaces_path.read_text(encoding="utf-8"))["components"]
        if interfaces_path
        else {}
    )
    mesh_by_name = {item["name"]: item for item in mesh_manifest["components"]}
    status_by_name = {item["name"]: item for item in assembly["components"]}

    components = []
    missing = []
    for name, status_item in status_by_name.items():
        mesh = mesh_by_name.get(name)
        if not mesh:
            missing.append(name)
            continue
        bounds = mesh["bounds_mm"]
        status = status_item["status"]
        base_center = bounds["center"]
        holes = []
        for hole in interfaces.get(name, {}).get("holes", []):
            holes.append(
                {
                    "id": hole["id"],
                    "radiusMm": hole["radiusMm"],
                    "diameterMm": hole["diameterMm"],
                    "depthMm": hole["depthMm"],
                    "localCenterMm": [
                        round(hole["centerMm"][axis] - base_center[axis], 6)
                        for axis in range(3)
                    ],
                    "localAxis": hole["axis"],
                }
            )
        planes = []
        for plane in interfaces.get(name, {}).get("planes", []):
            planes.append(
                {
                    "id": plane["id"],
                    "areaMm2": plane["areaMm2"],
                    "localCenterMm": [
                        round(plane["centerMm"][axis] - base_center[axis], 6)
                        for axis in range(3)
                    ],
                    "localNormal": plane["normal"],
                }
            )
        shafts = []
        for shaft in interfaces.get(name, {}).get("shafts", []):
            shafts.append(
                {
                    "id": shaft["id"],
                    "radiusMm": shaft["radiusMm"],
                    "diameterMm": shaft["diameterMm"],
                    "lengthMm": shaft["lengthMm"],
                    "localCenterMm": [
                        round(shaft["centerMm"][axis] - base_center[axis], 6)
                        for axis in range(3)
                    ],
                    "localAxis": shaft["axis"],
                }
            )
        seats = [{
            "id": seat["id"], "radiusMm": seat["radiusMm"], "diameterMm": seat["diameterMm"],
            "lengthMm": seat["lengthMm"],
            "localCenterMm": [round(seat["centerMm"][axis] - base_center[axis], 6) for axis in range(3)],
            "localAxis": seat["axis"], "angularSpanDegrees": seat.get("angularSpanDegrees", 180),
        } for seat in interfaces.get(name, {}).get("seats", [])]
        edges = [{
            "id": edge["id"],
            "lengthMm": edge["lengthMm"],
            "localCenterMm": [round(edge["centerMm"][axis] - base_center[axis], 6) for axis in range(3)],
            "localDirection": edge["direction"],
        } for edge in interfaces.get(name, {}).get("edges", [])]
        points = [{
            "id": point["id"],
            "localPointMm": [round(point["pointMm"][axis] - base_center[axis], 6) for axis in range(3)],
        } for point in interfaces.get(name, {}).get("points", [])]
        centers = [{"id": "center-001", "localPointMm": [0.0, 0.0, 0.0]}]
        axes = ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
        midplanes = [{
            "id": f"midplane-{axis_name}", "localCenterMm": [0.0, 0.0, 0.0], "localNormal": axis,
            "areaMm2": mesh["size_mm"][(index + 1) % 3] * mesh["size_mm"][(index + 2) % 3],
        } for index, (axis_name, axis) in enumerate(zip(("x", "y", "z"), axes))]
        components.append(
            {
                "id": name,
                "label": status_item["label"],
                "status": status,
                "group": mesh["group"],
                "meshUrl": "/assets/assembly/" + mesh["stl"],
                "triangles": mesh["triangles"],
                "sizeMm": mesh["size_mm"],
                "baseBoundsMm": bounds,
                "transform": {
                    "positionMm": bounds["center"],
                    "quaternionXyzw": [0.0, 0.0, 0.0, 1.0],
                },
                "visible": True,
                "locked": name == "chassis_4mm",
                "color": COLORS.get(status, "#79a9d1"),
                "evidence": status_item.get("interface_evidence", ""),
                "interfaces": {
                    "holes": holes, "planes": planes, "shafts": shafts, "seats": seats, "edges": edges,
                    "points": points, "centers": centers, "midplanes": midplanes,
                },
            }
        )

    payload = {
        "schemaVersion": 1,
        "revision": 0,
        "name": "RC Car collaborative assembly",
        "baseAssembly": assembly["assembly"],
        "source": assembly["source"],
        "components": components,
        "mates": [],
        "history": [],
        "validation": {
            "exact": collisions,
            "exactRevision": 0,
            "approximate": [],
        },
        "warnings": ([f"Missing meshes: {', '.join(missing)}"] if missing else []),
    }
    atomic_json(output_path, payload)
    print(f"Prepared {len(components)} web components; missing meshes: {len(missing)}")


main()
