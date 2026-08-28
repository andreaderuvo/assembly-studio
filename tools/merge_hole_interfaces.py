#!/usr/bin/env python3
"""Merge extracted hole interfaces into an existing web state without reset."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def atomic_json(path, payload):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.replace(temporary, path)


def local_holes(component, extracted):
    base_center = component["baseBoundsMm"]["center"]
    result = []
    for hole in extracted.get(component["id"], {}).get("holes", []):
        result.append(
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
    return result


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: merge_hole_interfaces.py STATE.json HOLES.json")
    state_path = Path(sys.argv[1]).resolve()
    holes_path = Path(sys.argv[2]).resolve()
    state = json.loads(state_path.read_text(encoding="utf-8"))
    holes = json.loads(holes_path.read_text(encoding="utf-8"))["components"]
    total = 0
    for component in state["components"]:
        component.setdefault("interfaces", {})["holes"] = local_holes(component, holes)
        total += len(component["interfaces"]["holes"])
    state.setdefault("mates", [])
    atomic_json(state_path, state)
    print(f"Merged {total} holes into revision {state['revision']}")


main()
