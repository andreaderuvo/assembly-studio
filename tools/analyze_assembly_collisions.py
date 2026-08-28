#!/usr/bin/env python3
"""Report solid intersections while keeping OpenCascade memory bounded.

Every exact boolean runs in a short-lived child. OpenCascade may retain caches
until process exit, which previously made the all-in-one loop exhaust RAM.
"""

from __future__ import annotations

import json
import os
import resource
import signal
import sys
import tempfile
import time
from pathlib import Path

import FreeCAD as App


DEFAULT_TIMEOUT_SECONDS = 45.0
DEFAULT_EXTRA_MEMORY_MB = 512
MIN_COLLISION_VOLUME_MM3 = 0.05


def boxes_overlap(a, b, tolerance=0.01):
    return not (
        a.XMax <= b.XMin + tolerance or b.XMax <= a.XMin + tolerance
        or a.YMax <= b.YMin + tolerance or b.YMax <= a.YMin + tolerance
        or a.ZMax <= b.ZMin + tolerance or b.ZMax <= a.ZMin + tolerance
    )


def env_limit(name, default, number_type):
    try:
        value = number_type(os.environ.get(name, default))
        return value if value > 0 else default
    except ValueError:
        print(f"Ignoring invalid {name}; using {default}", file=sys.stderr)
        return default


def atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def current_virtual_memory():
    try:
        pages = int(Path("/proc/self/statm").read_text(encoding="ascii").split()[0])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return 0


def compute_in_child(first, second, result_path, extra_memory_mb):
    try:
        current_vms = current_virtual_memory()
        if current_vms:
            limit = current_vms + extra_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        try:
            common = first.Shape.common(second.Shape)
            result = {"volume": float(common.Volume)}
        except BaseException as exc:
            result = {"error": f"{type(exc).__name__}: {exc}"}
        atomic_write(result_path, result)
        os._exit(0)
    except BaseException:
        os._exit(70)


def isolated_common(first, second, work_dir, timeout_seconds, extra_memory_mb):
    descriptor, result_name = tempfile.mkstemp(
        prefix="collision-", suffix=".json", dir=str(work_dir)
    )
    os.close(descriptor)
    result_path = Path(result_name)
    result_path.unlink()
    sys.stdout.flush()
    sys.stderr.flush()
    pid = os.fork()
    if pid == 0:
        compute_in_child(first, second, result_path, extra_memory_mb)

    deadline = time.monotonic() + timeout_seconds
    status = None
    while time.monotonic() < deadline:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        try:
            result_path.unlink()
        except FileNotFoundError:
            pass
        return {"status": "timeout", "timeout_seconds": timeout_seconds}

    try:
        if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 and result_path.exists():
            return {"status": "ok", **json.loads(result_path.read_text(encoding="utf-8"))}
        if os.WIFSIGNALED(status):
            return {
                "status": "worker-crashed",
                "signal": os.WTERMSIG(status),
                "detail": "memory limit or OpenCascade crash",
            }
        return {"status": "worker-failed", "exit_code": os.WEXITSTATUS(status)}
    finally:
        try:
            result_path.unlink()
        except FileNotFoundError:
            pass


def make_report(model_path, part_count, candidate_count, completed, collisions, failures):
    return {
        "assembly": str(model_path),
        "parts": part_count,
        "aabb_candidate_pairs": candidate_count,
        "completed_candidate_pairs": completed,
        "complete": completed == candidate_count,
        "collisions": sorted(
            collisions,
            key=lambda item: item.get("intersection_volume_mm3", 0.0),
            reverse=True,
        ),
        "failed_pairs": failures,
    }


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) != 2:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass ASSEMBLY.FCStd REPORT.json")
    if not hasattr(os, "fork"):
        raise SystemExit("The memory-safe analyzer requires a POSIX system")

    model_path = Path(passed[0]).resolve()
    report_path = Path(passed[1]).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    timeout = env_limit("RC_CAR_COLLISION_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS, float)
    extra_memory = env_limit(
        "RC_CAR_COLLISION_EXTRA_MEMORY_MB", DEFAULT_EXTRA_MEMORY_MB, int
    )
    doc = App.openDocument(str(model_path))
    parts = []
    for obj in doc.Objects:
        if getattr(obj, "Group", None):
            continue
        if not hasattr(obj, "Shape"):
            continue
        try:
            if obj.Shape.isNull() or not obj.Shape.Solids:
                continue
        except Exception:
            continue
        parts.append(obj)

    candidates = []
    for index, first in enumerate(parts):
        for second in parts[index + 1 :]:
            if boxes_overlap(first.Shape.BoundBox, second.Shape.BoundBox):
                candidates.append((first, second))

    collisions = []
    failures = []
    atomic_write(report_path, make_report(
        model_path, len(parts), len(candidates), 0, collisions, failures
    ))
    print(
        f"parts={len(parts)} candidates={len(candidates)} "
        f"timeout={timeout:g}s extra_memory={extra_memory}MiB",
        flush=True,
    )

    for completed, (first, second) in enumerate(candidates, start=1):
        result = isolated_common(first, second, report_path.parent, timeout, extra_memory)
        pair = {
            "first": first.Name,
            "first_label": first.Label,
            "second": second.Name,
            "second_label": second.Label,
        }
        if result["status"] != "ok" or "error" in result:
            failures.append({**pair, **result})
        elif result["volume"] > MIN_COLLISION_VOLUME_MM3:
            collisions.append({
                **pair,
                "intersection_volume_mm3": round(result["volume"], 4),
            })
        atomic_write(report_path, make_report(
            model_path, len(parts), len(candidates), completed, collisions, failures
        ))
        print(
            f"[{completed}/{len(candidates)}] {first.Name} x {second.Name}: {result['status']}",
            flush=True,
        )

    print(
        f"parts={len(parts)} candidates={len(candidates)} "
        f"collisions={len(collisions)} failed={len(failures)}",
        flush=True,
    )
    App.closeDocument(doc.Name)


main()
