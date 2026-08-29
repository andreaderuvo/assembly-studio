#!/usr/bin/env python3
"""Apply web transforms to a lightweight FCStd assembly and save a new copy."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import FreeCAD as App
import Import
import Part


def vector(values):
    return App.Vector(float(values[0]), float(values[1]), float(values[2]))


def rgb_color(value):
    text = str(value or "").lstrip("#")
    if len(text) != 6:
        return None
    try:
        return tuple(int(text[index : index + 2], 16) / 255.0 for index in (0, 2, 4))
    except ValueError:
        return None


def fastener_shape(component):
    spec = component["fastener"]
    standard = str(spec["standard"])
    diameter = float(spec["diameterMm"])
    length = float(spec["lengthMm"])
    head_diameter = float(spec["headDiameterMm"])
    head_height = float(spec["headHeightMm"])

    if standard == "ISO10642":
        shank_length = max(length - head_height, 0.01)
        shank = Part.makeCylinder(
            diameter / 2.0,
            shank_length,
            App.Vector(0, 0, -length),
        )
        head = Part.makeCone(
            diameter / 2.0,
            head_diameter / 2.0,
            head_height,
            App.Vector(0, 0, -head_height),
        )
        shape = shank.fuse(head)
    elif standard == "ISO7380":
        shank = Part.makeCylinder(
            diameter / 2.0,
            length,
            App.Vector(0, 0, -length),
        )
        radius = head_diameter / 2.0
        dome = [
            App.Vector(
                radius * math.cos(index / 16.0 * math.pi / 2.0),
                0,
                head_height * math.sin(index / 16.0 * math.pi / 2.0),
            )
            for index in range(17)
        ]
        profile = Part.makePolygon([App.Vector(0, 0, 0), *dome, App.Vector(0, 0, 0)])
        head = Part.Face(profile).revolve(App.Vector(0, 0, 0), App.Vector(0, 0, 1), 360)
        shape = shank.fuse(head)
    else:
        shank = Part.makeCylinder(
            diameter / 2.0,
            length,
            App.Vector(0, 0, -length),
        )
        head = Part.makeCylinder(
            head_diameter / 2.0,
            head_height,
            App.Vector(0, 0, 0),
        )
        shape = shank.fuse(head)

    socket_across_flats = float(spec.get("socketAcrossFlatsMm", diameter * 0.75))
    socket_depth = min(float(spec.get("socketDepthMm", head_height * 0.45)), head_height * 0.9)
    socket_radius = socket_across_flats / math.sqrt(3.0)
    socket_top = 0.0 if standard == "ISO10642" else head_height
    socket_bottom = socket_top - socket_depth
    socket_points = [
        App.Vector(
            socket_radius * math.cos(math.radians(60.0 * index + 30.0)),
            socket_radius * math.sin(math.radians(60.0 * index + 30.0)),
            socket_bottom,
        )
        for index in range(6)
    ]
    socket_wire = Part.makePolygon(socket_points + [socket_points[0]])
    socket_tool = Part.Face(socket_wire).extrude(App.Vector(0, 0, socket_depth + 0.01))
    shape = shape.cut(socket_tool)

    center = shape.BoundBox.Center
    shape.translate(-center)
    return shape


def bearing_shape(component):
    spec = component["bearing"]
    width = float(spec["widthMm"])
    origin = App.Vector(0, 0, -width / 2.0)
    outer = Part.makeCylinder(float(spec["outerDiameterMm"]) / 2.0, width, origin)
    inner = Part.makeCylinder(float(spec["innerDiameterMm"]) / 2.0, width, origin)
    return outer.cut(inner)


def place_shape(shape, transform):
    target_center = vector(transform["positionMm"])
    quaternion = transform["quaternionXyzw"]
    rotation = App.Rotation(
        float(quaternion[0]),
        float(quaternion[1]),
        float(quaternion[2]),
        float(quaternion[3]),
    )
    angle_degrees = math.degrees(float(rotation.Angle))
    if abs(angle_degrees) > 1e-9:
        shape.rotate(App.Vector(0, 0, 0), rotation.Axis, angle_degrees)
    shape.translate(target_center)
    return shape


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) not in (3, 4):
        raise SystemExit(
            "Usage: freecadcmd SCRIPT --pass BASE.FCStd STATE.json OUTPUT.FCStd [OUTPUT.step]"
        )

    base_path, state_path, output_path = map(lambda value: Path(value).resolve(), passed[:3])
    output_step_path = Path(passed[3]).resolve() if len(passed) == 4 else None
    state = json.loads(state_path.read_text(encoding="utf-8"))
    doc = App.openDocument(str(base_path))
    source_doc = None
    # Catalog solids were already exported exactly from the source FCStd. Load
    # only the requested STEP files instead of opening the 16 MiB parametric
    # source document, which is slow, restores unavailable addons and creates a
    # large avoidable memory spike. Keep the source document as a fallback.
    step_manifest_path = (
        Path(__file__).resolve().parents[1] / "build" / "step_export" / "step_manifest.json"
    )
    catalog_step_paths = {}
    if step_manifest_path.is_file():
        step_manifest = json.loads(step_manifest_path.read_text(encoding="utf-8"))
        catalog_step_paths = {
            item["name"]: step_manifest_path.parent / item["step"]
            for item in step_manifest.get("components", [])
            if item.get("name") and item.get("step")
        }
    instance_source_ids = {
        component.get("instanceOf")
        for component in state["components"]
        if component.get("kind") == "instance" and not component.get("catalogSource")
    }
    instance_source_shapes = {
        object_id: doc.getObject(object_id).Shape.copy()
        for object_id in instance_source_ids
        if object_id and doc.getObject(object_id) is not None
        and hasattr(doc.getObject(object_id), "Shape")
    }
    changed = 0

    for component in state["components"]:
        if component.get("kind") == "fastener":
            if not bool(component.get("visible", True)):
                continue
            obj = doc.addObject("Part::Feature", component["id"])
            obj.Label = component.get("label", component["id"])
            obj.addProperty("App::PropertyString", "Standard", "Fastener")
            obj.addProperty("App::PropertyString", "MetricSize", "Fastener")
            obj.addProperty("App::PropertyLength", "FastenerLength", "Fastener")
            obj.Standard = str(component["fastener"]["standard"])
            obj.MetricSize = f'M{component["fastener"]["diameterMm"]:g}'
            obj.FastenerLength = float(component["fastener"]["lengthMm"])
            obj.Shape = place_shape(fastener_shape(component), component["transform"])
            try:
                color = rgb_color(component.get("color"))
                if color is not None:
                    obj.ViewObject.ShapeColor = color
            except Exception:
                pass
            changed += 1
            continue
        if component.get("kind") == "bearing":
            if not bool(component.get("visible", True)):
                continue
            obj = doc.addObject("Part::Feature", component["id"])
            obj.Label = component.get("label", component["id"])
            obj.addProperty("App::PropertyString", "Series", "Bearing")
            obj.addProperty("App::PropertyLength", "InnerDiameter", "Bearing")
            obj.addProperty("App::PropertyLength", "OuterDiameter", "Bearing")
            obj.addProperty("App::PropertyLength", "BearingWidth", "Bearing")
            obj.addProperty("App::PropertyString", "Closure", "Bearing")
            obj.addProperty("App::PropertyString", "SealColor", "Bearing")
            spec = component["bearing"]
            obj.Series = str(spec["series"])
            obj.InnerDiameter = float(spec["innerDiameterMm"])
            obj.OuterDiameter = float(spec["outerDiameterMm"])
            obj.BearingWidth = float(spec["widthMm"])
            obj.Closure = str(spec.get("closure", "zz")).upper()
            obj.SealColor = str(spec.get("sealColor", "#c8cdd1"))
            obj.Shape = place_shape(bearing_shape(component), component["transform"])
            try:
                color = rgb_color(component.get("color"))
                if color is not None:
                    obj.ViewObject.ShapeColor = color
                    seal_color = rgb_color(spec.get("sealColor")) or color
                    obj.ViewObject.DiffuseColor = [
                        seal_color if type(face.Surface).__name__ == "Plane" else color
                        for face in obj.Shape.Faces
                    ]
            except Exception:
                pass
            changed += 1
            continue
        if component.get("kind") == "instance":
            if not bool(component.get("visible", True)):
                continue
            if component.get("catalogSource"):
                object_name = component["catalogSource"]["objectName"]
                catalog_step_path = catalog_step_paths.get(object_name)
                if catalog_step_path is not None and catalog_step_path.is_file():
                    shape = Part.read(str(catalog_step_path))
                else:
                    if source_doc is None:
                        source_doc = App.openDocument(str(Path(state["source"]).resolve()))
                    source_obj = source_doc.getObject(object_name)
                    shape = source_obj.Shape.copy() if source_obj is not None else None
            else:
                source_shape = instance_source_shapes.get(component.get("instanceOf"))
                shape = source_shape.copy() if source_shape is not None else None
            if shape is None:
                print(f'Skipped missing instance source {component["id"]}', file=sys.stderr)
                continue
            base_center = vector(component["baseBoundsMm"]["center"])
            target_center = vector(component["transform"]["positionMm"])
            quaternion = component["transform"]["quaternionXyzw"]
            rotation = App.Rotation(*map(float, quaternion))
            angle_degrees = math.degrees(float(rotation.Angle))
            if abs(angle_degrees) > 1e-9:
                shape.rotate(base_center, rotation.Axis, angle_degrees)
            shape.translate(target_center - base_center)
            obj = doc.addObject("Part::Feature", component["id"])
            obj.Label = component.get("label", component["id"])
            obj.addProperty("App::PropertyString", "SourceComponent", "Instance")
            obj.SourceComponent = str(component.get("instanceOf", ""))
            obj.Shape = shape
            try:
                color = rgb_color(component.get("color"))
                if color is not None:
                    obj.ViewObject.ShapeColor = color
            except Exception:
                pass
            changed += 1
            continue
        if component.get("kind") == "catalog-stl":
            if not bool(component.get("visible", True)):
                continue
            object_name = component["catalogSource"]["objectName"]
            catalog_step_path = catalog_step_paths.get(object_name)
            if catalog_step_path is not None and catalog_step_path.is_file():
                shape = Part.read(str(catalog_step_path))
            else:
                if source_doc is None:
                    source_doc = App.openDocument(str(Path(state["source"]).resolve()))
                source_obj = source_doc.getObject(object_name)
                shape = source_obj.Shape.copy() if source_obj is not None else None
            if shape is None:
                print(f'Skipped missing source object {component["id"]}', file=sys.stderr)
                continue
            base_center = vector(component["baseBoundsMm"]["center"])
            target_center = vector(component["transform"]["positionMm"])
            quaternion = component["transform"]["quaternionXyzw"]
            rotation = App.Rotation(
                float(quaternion[0]), float(quaternion[1]),
                float(quaternion[2]), float(quaternion[3]),
            )
            angle_degrees = math.degrees(float(rotation.Angle))
            if abs(angle_degrees) > 1e-9:
                shape.rotate(base_center, rotation.Axis, angle_degrees)
            shape.translate(target_center - base_center)
            obj = doc.addObject("Part::Feature", component["id"])
            obj.Label = component.get("label", component["id"])
            obj.Shape = shape
            try:
                color = rgb_color(component.get("color"))
                if color is not None:
                    obj.ViewObject.ShapeColor = color
            except Exception:
                pass
            changed += 1
            continue
        obj = doc.getObject(component["id"])
        if obj is None or not hasattr(obj, "Shape"):
            continue
        if not bool(component.get("visible", True)):
            # Keep the catalog entry in web state, but omit its geometry from
            # the exported assembly and exact collision analysis.
            obj.Shape = Part.Shape()
            try:
                obj.ViewObject.Visibility = False
            except Exception:
                pass
            changed += 1
            continue
        bounds = component["baseBoundsMm"]
        base_center = vector(bounds["center"])
        target_center = vector(component["transform"]["positionMm"])
        quaternion = component["transform"]["quaternionXyzw"]
        rotation = App.Rotation(
            float(quaternion[0]),
            float(quaternion[1]),
            float(quaternion[2]),
            float(quaternion[3]),
        )

        shape = obj.Shape.copy()
        angle_degrees = math.degrees(float(rotation.Angle))
        if abs(angle_degrees) > 1e-9:
            shape.rotate(base_center, rotation.Axis, angle_degrees)
        shape.translate(target_center - base_center)
        obj.Shape = shape
        try:
            obj.ViewObject.Visibility = bool(component.get("visible", True))
            color = rgb_color(component.get("color"))
            if color is not None:
                obj.ViewObject.ShapeColor = color
        except Exception:
            pass
        changed += 1

    doc.recompute()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveAs(str(output_path))
    if output_step_path is not None:
        export_objects = []
        for component in state["components"]:
            if not bool(component.get("visible", True)):
                continue
            obj = doc.getObject(component["id"])
            if obj is None or not hasattr(obj, "Shape") or obj.Shape.isNull():
                continue
            export_objects.append(obj)
        if not export_objects:
            raise RuntimeError("The assembly contains no visible solids to export")
        output_step_path.parent.mkdir(parents=True, exist_ok=True)
        Import.export(export_objects, str(output_step_path))
        print(f"Exported {len(export_objects)} visible components to {output_step_path}")
    if source_doc is not None:
        App.closeDocument(source_doc.Name)
    App.closeDocument(doc.Name)
    print(f"Applied {changed} component transforms to {output_path}")


main()
