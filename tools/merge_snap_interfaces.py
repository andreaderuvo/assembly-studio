#!/usr/bin/env python3
"""Merge all CAD snap interfaces without resetting assembly work or history."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def local_point(point, base_center):
    return [round(point[index] - base_center[index], 6) for index in range(3)]


def atomic_json(path, payload):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.replace(temporary, path)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: merge_snap_interfaces.py STATE.json SNAP_INTERFACES.json")
    state_path = Path(sys.argv[1]).resolve()
    source_path = Path(sys.argv[2]).resolve()
    state = json.loads(state_path.read_text(encoding="utf-8"))
    extracted = json.loads(source_path.read_text(encoding="utf-8"))["components"]
    totals = {"holes": 0, "planes": 0, "shafts": 0, "seats": 0, "edges": 0, "points": 0, "centers": 0, "midplanes": 0}
    for component in state["components"]:
        source = extracted.get(component["id"], {})
        center = component["baseBoundsMm"]["center"]
        holes = [{
            "id": item["id"], "radiusMm": item["radiusMm"], "diameterMm": item["diameterMm"],
            "depthMm": item["depthMm"], "localCenterMm": local_point(item["centerMm"], center),
            "localAxis": item["axis"],
        } for item in source.get("holes", [])]
        planes = [{
            "id": item["id"], "areaMm2": item["areaMm2"],
            "localCenterMm": local_point(item["centerMm"], center), "localNormal": item["normal"],
        } for item in source.get("planes", [])]
        shafts = [{
            "id": item["id"], "radiusMm": item["radiusMm"], "diameterMm": item["diameterMm"],
            "lengthMm": item["lengthMm"], "localCenterMm": local_point(item["centerMm"], center),
            "localAxis": item["axis"],
        } for item in source.get("shafts", [])]
        seats = [{
            "id": item["id"], "radiusMm": item["radiusMm"], "diameterMm": item["diameterMm"],
            "lengthMm": item["lengthMm"], "localCenterMm": local_point(item["centerMm"], center),
            "localAxis": item["axis"], "angularSpanDegrees": item.get("angularSpanDegrees", 180),
        } for item in source.get("seats", [])]
        edges = [{
            "id": item["id"], "lengthMm": item["lengthMm"],
            "localCenterMm": local_point(item["centerMm"], center), "localDirection": item["direction"],
        } for item in source.get("edges", [])]
        points = [{
            "id": item["id"], "localPointMm": local_point(item["pointMm"], center),
        } for item in source.get("points", [])]
        centers = [{"id": "center-001", "localPointMm": [0.0, 0.0, 0.0]}]
        axes = ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
        midplanes = [{
            "id": f"midplane-{axis_name}", "localCenterMm": [0.0, 0.0, 0.0], "localNormal": axis,
            "areaMm2": component["sizeMm"][(index + 1) % 3] * component["sizeMm"][(index + 2) % 3],
        } for index, (axis_name, axis) in enumerate(zip(("x", "y", "z"), axes))]
        component["interfaces"] = {
            "holes": holes, "planes": planes, "shafts": shafts, "seats": seats, "edges": edges,
            "points": points, "centers": centers, "midplanes": midplanes,
        }
        for kind, items in component["interfaces"].items():
            totals[kind] += len(items)
    state.setdefault("mates", [])
    state.setdefault("joints", [])
    atomic_json(state_path, state)
    print(f"Merged {totals} into revision {state['revision']}")


main()
