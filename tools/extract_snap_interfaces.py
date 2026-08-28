#!/usr/bin/env python3
"""Extract planar faces, external shafts, and holes for magnetic CAD snaps."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import FreeCAD as App

from extract_hole_interfaces import canonical_axis, object_holes, values


MIN_PLANE_AREA_MM2 = 8.0
MAX_PLANES_PER_COMPONENT = 60
MAX_EDGES_PER_COMPONENT = 60
MAX_POINTS_PER_COMPONENT = 60
MIN_EDGE_LENGTH_MM = 1.5
MIN_SHAFT_RADIUS_MM = 0.5
MAX_SHAFT_RADIUS_MM = 40.0
MIN_SHAFT_LENGTH_MM = 0.7
FULL_CYLINDER_RADIANS = math.tau * 0.96
MIN_SEAT_RADIANS = math.pi * 0.4
MAX_SEAT_RADIANS = math.pi * 1.6


def rounded_vector(vector):
    return [round(value, 7) for value in values(vector)]


def face_midpoint(face):
    u_min, u_max, v_min, v_max = face.ParameterRange
    return face.valueAt((u_min + u_max) * 0.5, (v_min + v_max) * 0.5)


def planar_interfaces(obj):
    planes = []
    candidates = [
        (face_index, face)
        for face_index, face in enumerate(obj.Shape.Faces, 1)
        if type(face.Surface).__name__ == "Plane" and float(face.Area) >= MIN_PLANE_AREA_MM2
    ]
    candidates.sort(key=lambda entry: float(entry[1].Area), reverse=True)
    for face_index, face in candidates[:MAX_PLANES_PER_COMPONENT]:
        u_min, u_max, v_min, v_max = face.ParameterRange
        normal = App.Vector(face.normalAt((u_min + u_max) * 0.5, (v_min + v_max) * 0.5))
        normal.normalize()
        center = App.Vector(face.CenterOfMass)
        epsilon = 0.05
        positive_inside = obj.Shape.isInside(center + normal * epsilon, 1e-5, False)
        negative_inside = obj.Shape.isInside(center - normal * epsilon, 1e-5, False)
        if positive_inside and not negative_inside:
            normal = normal.negative()
        planes.append(
            {
                "sourceFace": face_index,
                "areaMm2": round(float(face.Area), 3),
                "centerMm": [round(value, 6) for value in values(center)],
                "normal": rounded_vector(normal),
            }
        )
    planes.sort(key=lambda item: (-item["areaMm2"], *item["centerMm"]))
    for index, plane in enumerate(planes, 1):
        plane["id"] = f"plane-{index:03d}"
    return planes


def cylinder_is_external(obj, face, surface):
    point = App.Vector(face_midpoint(face))
    axis = canonical_axis(surface.Axis)
    origin = App.Vector(surface.Center)
    radial = point - (origin + axis * ((point - origin).dot(axis)))
    if radial.Length < 1e-6:
        return False
    radial.normalize()
    epsilon = min(0.2, max(0.04, float(surface.Radius) * 0.04))
    inward = obj.Shape.isInside(point - radial * epsilon, 1e-5, False)
    outward = obj.Shape.isInside(point + radial * epsilon, 1e-5, False)
    return bool(inward and not outward)


def shaft_interfaces(obj):
    shafts = []
    for face_index, face in enumerate(obj.Shape.Faces, 1):
        surface = face.Surface
        if type(surface).__name__ != "Cylinder":
            continue
        radius = float(surface.Radius)
        u_min, u_max, _, _ = face.ParameterRange
        if not MIN_SHAFT_RADIUS_MM <= radius <= MAX_SHAFT_RADIUS_MM:
            continue
        if abs(u_max - u_min) < FULL_CYLINDER_RADIANS or not cylinder_is_external(obj, face, surface):
            continue
        axis = canonical_axis(surface.Axis)
        projections = [App.Vector(vertex.Point).dot(axis) for vertex in face.Vertexes]
        if not projections:
            continue
        low, high = min(projections), max(projections)
        length = high - low
        if length < MIN_SHAFT_LENGTH_MM:
            continue
        surface_center = App.Vector(surface.Center)
        center = surface_center + axis * ((low + high) * 0.5 - surface_center.dot(axis))
        shafts.append(
            {
                "sourceFace": face_index,
                "radiusMm": round(radius, 4),
                "diameterMm": round(radius * 2, 4),
                "lengthMm": round(length, 4),
                "centerMm": [round(value, 6) for value in values(center)],
                "axis": rounded_vector(axis),
            }
        )
    shafts.sort(key=lambda item: (item["radiusMm"], *item["centerMm"]))
    for index, shaft in enumerate(shafts, 1):
        shaft["id"] = f"shaft-{index:03d}"
    return shafts


def cylindrical_seat_interfaces(obj):
    """Find concave partial cylinders such as open bearing/shaft saddles."""
    seats = []
    for face_index, face in enumerate(obj.Shape.Faces, 1):
        surface = face.Surface
        if type(surface).__name__ != "Cylinder":
            continue
        radius = float(surface.Radius)
        u_min, u_max, v_min, v_max = face.ParameterRange
        angular_span = abs(u_max - u_min)
        if not MIN_SHAFT_RADIUS_MM <= radius <= MAX_SHAFT_RADIUS_MM:
            continue
        if not MIN_SEAT_RADIANS <= angular_span <= MAX_SEAT_RADIANS:
            continue
        point = App.Vector(face.valueAt((u_min + u_max) * .5, (v_min + v_max) * .5))
        axis = canonical_axis(surface.Axis)
        origin = App.Vector(surface.Center)
        radial = point - (origin + axis * ((point - origin).dot(axis)))
        if radial.Length < 1e-6:
            continue
        radial.normalize()
        epsilon = min(.2, max(.04, radius * .04))
        toward_axis_inside = obj.Shape.isInside(point - radial * epsilon, 1e-5, False)
        away_from_axis_inside = obj.Shape.isInside(point + radial * epsilon, 1e-5, False)
        if toward_axis_inside or not away_from_axis_inside:
            continue
        projections = [App.Vector(vertex.Point).dot(axis) for vertex in face.Vertexes]
        if not projections:
            continue
        low, high = min(projections), max(projections)
        length = high - low
        if length < MIN_SHAFT_LENGTH_MM:
            continue
        center = origin + axis * ((low + high) * .5 - origin.dot(axis))
        seats.append({
            "sourceFace": face_index,
            "radiusMm": round(radius, 4),
            "diameterMm": round(radius * 2, 4),
            "lengthMm": round(length, 4),
            "angularSpanDegrees": round(math.degrees(angular_span), 2),
            "centerMm": [round(value, 6) for value in values(center)],
            "axis": rounded_vector(axis),
        })
    seats.sort(key=lambda item: (item["radiusMm"], *item["centerMm"]))
    for index, seat in enumerate(seats, 1):
        seat["id"] = f"seat-{index:03d}"
    return seats


def linear_interfaces(obj):
    edges = []
    seen = set()
    for edge_index, edge in enumerate(obj.Shape.Edges, 1):
        if type(getattr(edge, "Curve", None)).__name__ != "Line" or len(edge.Vertexes) != 2:
            continue
        start = App.Vector(edge.Vertexes[0].Point)
        end = App.Vector(edge.Vertexes[1].Point)
        length = (end - start).Length
        if length < MIN_EDGE_LENGTH_MM:
            continue
        endpoints = sorted((tuple(round(value, 5) for value in values(start)), tuple(round(value, 5) for value in values(end))))
        key = tuple(endpoints)
        if key in seen:
            continue
        seen.add(key)
        direction = end - start
        direction.normalize()
        edges.append({
            "sourceEdge": edge_index,
            "lengthMm": round(length, 4),
            "centerMm": [round(value, 6) for value in values((start + end) * 0.5)],
            "direction": rounded_vector(direction),
        })
    edges.sort(key=lambda item: (-item["lengthMm"], *item["centerMm"]))
    edges = edges[:MAX_EDGES_PER_COMPONENT]
    for index, edge in enumerate(edges, 1):
        edge["id"] = f"edge-{index:03d}"
    return edges


def point_interfaces(obj):
    unique = {}
    for vertex_index, vertex in enumerate(obj.Shape.Vertexes, 1):
        point = App.Vector(vertex.Point)
        key = tuple(round(value, 5) for value in values(point))
        unique.setdefault(key, {
            "sourceVertex": vertex_index,
            "pointMm": [round(value, 6) for value in values(point)],
        })
    center = App.Vector(obj.Shape.BoundBox.Center)
    points = sorted(
        unique.values(),
        key=lambda item: -(App.Vector(*item["pointMm"]) - center).Length,
    )[:MAX_POINTS_PER_COMPONENT]
    points.sort(key=lambda item: item["pointMm"])
    for index, point in enumerate(points, 1):
        point["id"] = f"point-{index:03d}"
    return points


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) < 2:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass ASSEMBLY.FCStd OUTPUT.json [OBJECT ...]")
    model_path, output_path = map(lambda value: Path(value).resolve(), passed[:2])
    requested_objects = set(passed[2:])
    doc = App.openDocument(str(model_path))
    result = {
        "assembly": str(model_path),
        "components": {},
        "errors": {},
        "totals": {"holes": 0, "planes": 0, "shafts": 0, "seats": 0, "edges": 0, "points": 0},
    }
    for obj in doc.Objects:
        if requested_objects and obj.Name not in requested_objects:
            continue
        if (not requested_objects and getattr(obj, "Group", None)) or not hasattr(obj, "Shape"):
            continue
        try:
            if obj.Shape.isNull() or not obj.Shape.Solids:
                continue
        except Exception:
            continue
        try:
            interfaces = {
                "label": obj.Label,
                "holes": object_holes(obj),
                "planes": planar_interfaces(obj),
                "shafts": shaft_interfaces(obj),
                "seats": cylindrical_seat_interfaces(obj),
                "edges": linear_interfaces(obj),
                "points": point_interfaces(obj),
            }
        except Exception as error:
            result["errors"][obj.Name] = str(error)
            print(f"Skipped {obj.Name}: {error}", flush=True)
            continue
        result["components"][obj.Name] = interfaces
        for kind in result["totals"]:
            result["totals"][kind] += len(interfaces[kind])
        print(
            f"{obj.Name}: {len(interfaces['holes'])} holes, "
            f"{len(interfaces['planes'])} planes, {len(interfaces['shafts'])} shafts, "
            f"{len(interfaces['seats'])} seats, "
            f"{len(interfaces['edges'])} edges, {len(interfaces['points'])} points",
            flush=True,
        )
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    App.closeDocument(doc.Name)
    print(f"Extracted {result['totals']}")


main()
