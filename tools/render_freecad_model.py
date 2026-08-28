#!/usr/bin/env python3
"""Render the saved FreeCAD visibility state from standard viewpoints."""

from pathlib import Path
import sys

import FreeCAD as App
import FreeCADGui as Gui
from PySide6 import QtCore, QtWidgets


def main():
    args = list(sys.argv)
    try:
        pass_index = args.index("--pass")
        passed = args[pass_index + 1 :]
    except ValueError:
        passed = args[1:]

    if len(passed) != 2:
        raise SystemExit("Uso: freecad SCRIPT --pass MODEL.FCStd OUTPUT_DIR")

    model_path = Path(passed[0]).expanduser().resolve()
    output_dir = Path(passed[1]).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # When launched through the GUI executable the main window already exists.
    # Older releases exposed showMainWindow(); FreeCAD 1.1 no longer always does.
    if hasattr(Gui, "showMainWindow"):
        Gui.showMainWindow()

    # Missing optional workbenches can raise a modal warning during restore.
    # In an offscreen renderer there is nobody to click it, so acknowledge
    # warning boxes while retaining their text in the terminal log.
    def acknowledge_warnings():
        for widget in QtWidgets.QApplication.topLevelWidgets():
            if isinstance(widget, QtWidgets.QMessageBox) and widget.isVisible():
                print(f"Avviso FreeCAD: {widget.text()}")
                widget.accept()

    warning_timer = QtCore.QTimer()
    warning_timer.timeout.connect(acknowledge_warnings)
    warning_timer.start(250)

    doc = App.openDocument(str(model_path))
    # Headless-generated documents may not contain a saved GUI visibility state.
    # Make every geometric object and its parent containers visible for rendering.
    for obj in doc.Objects:
        try:
            if hasattr(obj, "Shape") and not obj.Shape.isNull():
                obj.ViewObject.Visibility = True
            elif obj.TypeId in {"App::Part", "App::DocumentObjectGroup"}:
                obj.ViewObject.Visibility = True
        except Exception:
            pass
    Gui.updateGui()
    Gui.activeDocument().activeView().setAnimationEnabled(False)
    Gui.activeDocument().activeView().setCornerCrossSize(0)

    view = Gui.activeDocument().activeView()
    viewpoints = {
        "assembly_axonometric.png": view.viewAxonometric,
        "assembly_top.png": view.viewTop,
        "assembly_front.png": view.viewFront,
        "assembly_right.png": view.viewRight,
    }

    for filename, orient in viewpoints.items():
        orient()
        view.fitAll(0.85)
        Gui.updateGui()
        view.saveImage(str(output_dir / filename), 1800, 1200, "White")
        print(output_dir / filename)

    warning_timer.stop()
    App.closeDocument(doc.Name)
    if hasattr(App, "quit"):
        App.quit()
    else:
        QtWidgets.QApplication.instance().quit()


# FreeCAD 1.1.x imports command-line scripts as modules.
main()
