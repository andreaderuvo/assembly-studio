#!/usr/bin/env python3
"""Merge targeted CAD interfaces into catalog components without changing assembly work."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def local_point(point, center):
    return [round(point[index] - center[index], 6) for index in range(3)]


def atomic_json(path, payload):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.replace(temporary, path)


def converted(component, source):
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
    axes = ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
    midplanes = [{
        "id": f"midplane-{name}", "localCenterMm": [0.0, 0.0, 0.0], "localNormal": axis,
        "areaMm2": component["sizeMm"][(index + 1) % 3] * component["sizeMm"][(index + 2) % 3],
    } for index, (name, axis) in enumerate(zip(("x", "y", "z"), axes))]
    return {
        "holes": holes, "planes": planes, "shafts": shafts, "seats": seats, "edges": edges, "points": points,
        "centers": [{"id": "center-001", "localPointMm": [0.0, 0.0, 0.0]}],
        "midplanes": midplanes,
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: merge_catalog_interfaces.py STATE.json SNAP_INTERFACES.json")
    state_path, report_path = map(lambda value: Path(value).resolve(), sys.argv[1:])
    state = json.loads(state_path.read_text(encoding="utf-8"))
    extracted = json.loads(report_path.read_text(encoding="utf-8"))["components"]
    updated = []
    for component in state["components"]:
        source_name = component.get("catalogSource", {}).get("objectName")
        if source_name not in extracted:
            continue
        component["interfaces"] = converted(component, extracted[source_name])
        updated.append((component["id"], len(component["interfaces"]["holes"])))
    atomic_json(state_path, state)
    print(f"Updated catalog interfaces: {updated}")


main()
