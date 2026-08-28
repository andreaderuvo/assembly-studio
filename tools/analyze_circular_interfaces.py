#!/usr/bin/env python3
"""List circular edges useful for matching holes between selected FreeCAD bodies."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import FreeCAD as App


def vec(v):
    return [round(v.x, 4), round(v.y, 4), round(v.z, 4)]


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) < 3:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass MODEL.FCStd OUTPUT.json OBJECT...")

    model_path = Path(passed[0]).resolve()
    output_path = Path(passed[1]).resolve()
    names = passed[2:]
    doc = App.openDocument(str(model_path))
    result = {}
    for name in names:
        obj = doc.getObject(name)
        circles = []
        if obj is not None and hasattr(obj, "Shape"):
            for edge in obj.Shape.Edges:
                curve = getattr(edge, "Curve", None)
                if not all(hasattr(curve, attr) for attr in ("Radius", "Center", "Axis")):
                    continue
                radius = float(curve.Radius)
                if radius < 0.4 or radius > 15.0:
                    continue
                circles.append(
                    {
                        "radius_mm": round(radius, 4),
                        "center_mm": vec(curve.Center),
                        "axis": vec(curve.Axis),
                        "length_mm": round(float(edge.Length), 4),
                    }
                )
        result[name] = {"label": obj.Label if obj else None, "circles": circles}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(output_path)
    App.closeDocument(doc.Name)


main()
