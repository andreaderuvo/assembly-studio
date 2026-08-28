#!/usr/bin/env python3
"""Extract screw-hole axes from a lightweight FreeCAD assembly.

Only pairs of complete, coaxial circular edges are accepted. This deliberately
rejects fillet arcs and most exterior cylindrical details, producing a useful
first set of magnetic mating interfaces without guessing from tessellated STL.
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import FreeCAD as App


MIN_RADIUS_MM = 0.45
MAX_RADIUS_MM = 10.0
FULL_CIRCLE_RELATIVE_TOLERANCE = 0.015
COAXIAL_TOLERANCE_MM = 0.05
MIN_DEPTH_MM = 0.35
FULL_CYLINDER_RADIANS = math.tau * 0.96


def values(vector):
    return [float(vector.x), float(vector.y), float(vector.z)]


def canonical_axis(axis):
    normalized = App.Vector(axis)
    normalized.normalize()
    for coordinate in (normalized.x, normalized.y, normalized.z):
        if abs(coordinate) > 1e-7:
            if coordinate < 0:
                normalized = normalized.negative()
            break
    return normalized


def group_key(center, axis):
    projection = axis * center.dot(axis)
    perpendicular = center - projection
    quantum = COAXIAL_TOLERANCE_MM
    return (
        round(axis.x, 3),
        round(axis.y, 3),
        round(axis.z, 3),
        round(perpendicular.x / quantum),
        round(perpendicular.y / quantum),
        round(perpendicular.z / quantum),
    )


def internal_cylindrical_holes(obj):
    holes = []
    for face in obj.Shape.Faces:
        surface = face.Surface
        if type(surface).__name__ != "Cylinder":
            continue
        radius = float(surface.Radius)
        u_min, u_max, v_min, v_max = face.ParameterRange
        if not MIN_RADIUS_MM <= radius <= MAX_RADIUS_MM or abs(u_max - u_min) < FULL_CYLINDER_RADIANS:
            continue
        point = App.Vector(face.valueAt((u_min + u_max) * 0.5, (v_min + v_max) * 0.5))
        axis = canonical_axis(surface.Axis)
        origin = App.Vector(surface.Center)
        radial = point - (origin + axis * ((point - origin).dot(axis)))
        if radial.Length < 1e-6:
            continue
        radial.normalize()
        epsilon = min(0.2, max(0.03, radius * 0.04))
        toward_axis_inside = obj.Shape.isInside(point - radial * epsilon, 1e-5, False)
        away_from_axis_inside = obj.Shape.isInside(point + radial * epsilon, 1e-5, False)
        if toward_axis_inside or not away_from_axis_inside:
            continue
        projections = [App.Vector(vertex.Point).dot(axis) for vertex in face.Vertexes]
        if not projections:
            continue
        low, high = min(projections), max(projections)
        depth = high - low
        if depth < MIN_DEPTH_MM:
            continue
        surface_center = App.Vector(surface.Center)
        center = surface_center + axis * ((low + high) * 0.5 - surface_center.dot(axis))
        holes.append({
            "radiusMm": round(radius, 4),
            "diameterMm": round(radius * 2.0, 4),
            "depthMm": round(depth, 4),
            "centerMm": [round(value, 6) for value in values(center)],
            "axis": [round(value, 7) for value in values(axis)],
            "edgeCount": len(face.Edges),
            "source": "internal-cylinder",
        })
    return holes


def object_holes(obj):
    groups = defaultdict(list)
    for edge in obj.Shape.Edges:
        curve = getattr(edge, "Curve", None)
        if not all(hasattr(curve, attribute) for attribute in ("Radius", "Center", "Axis")):
            continue
        radius = float(curve.Radius)
        if not MIN_RADIUS_MM <= radius <= MAX_RADIUS_MM:
            continue
        circumference = 2.0 * math.pi * radius
        if abs(float(edge.Length) - circumference) / circumference > FULL_CIRCLE_RELATIVE_TOLERANCE:
            continue
        center = App.Vector(curve.Center)
        axis = canonical_axis(curve.Axis)
        groups[group_key(center, axis)].append((center, axis, radius))

    holes = []
    for circles in groups.values():
        if len(circles) < 2:
            continue
        axis = circles[0][1]
        # Countersunk holes have different radii at their two openings. The
        # smallest radius represents the actual screw passage and is therefore
        # the useful value for compatibility matching.
        radius = min(circle[2] for circle in circles)
        positions = sorted(
            ((center.dot(axis), center) for center, _, _ in circles),
            key=lambda item: item[0],
        )
        depth = positions[-1][0] - positions[0][0]
        if depth < MIN_DEPTH_MM:
            continue
        center = (positions[0][1] + positions[-1][1]) * 0.5
        holes.append(
            {
                "radiusMm": round(radius, 4),
                "diameterMm": round(radius * 2.0, 4),
                "depthMm": round(depth, 4),
                "centerMm": [round(value, 6) for value in values(center)],
                "axis": [round(value, 7) for value in values(axis)],
                "edgeCount": len(circles),
            }
        )
    for candidate in internal_cylindrical_holes(obj):
        duplicate = any(
            abs(existing["radiusMm"] - candidate["radiusMm"]) < 0.02
            and (App.Vector(*existing["centerMm"]) - App.Vector(*candidate["centerMm"])).Length < 0.08
            and abs(App.Vector(*existing["axis"]).dot(App.Vector(*candidate["axis"]))) > 0.999
            for existing in holes
        )
        if not duplicate:
            holes.append(candidate)
    holes.sort(key=lambda item: (item["radiusMm"], *item["centerMm"]))
    for index, hole in enumerate(holes, 1):
        hole["id"] = f"hole-{index:03d}"
    return holes


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) != 2:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass ASSEMBLY.FCStd OUTPUT.json")

    model_path, output_path = map(lambda value: Path(value).resolve(), passed)
    doc = App.openDocument(str(model_path))
    result = {"assembly": str(model_path), "components": {}, "totalHoles": 0}
    for obj in doc.Objects:
        if getattr(obj, "Group", None) or not hasattr(obj, "Shape"):
            continue
        try:
            if obj.Shape.isNull() or not obj.Shape.Solids:
                continue
        except Exception:
            continue
        holes = object_holes(obj)
        result["components"][obj.Name] = {"label": obj.Label, "holes": holes}
        result["totalHoles"] += len(holes)
        print(f"{obj.Name}: {len(holes)} holes", flush=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    App.closeDocument(doc.Name)
    print(f"Extracted {result['totalHoles']} holes")


if Path(sys.argv[0]).name == "extract_hole_interfaces.py":
    main()
