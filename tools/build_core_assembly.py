#!/usr/bin/env python3
"""Build a lightweight, normalized core assembly from the source document.

The source file is never modified. Existing Assembly links are copied with their
solved placements. The rear upper deck is added from its authored placement and
explicitly marked provisional for geometric validation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import FreeCAD as App


EXACT_LINKS = [
    "chassis_4mm",
    "rear_tower_left",
    "rear_tower_right",
    "lipo_holder_flex",
    "lipo_barrier_rear003",
    "lipo_barrier_rear004",
]
PROVISIONAL_BODIES = ["Body354"]  # rear_upperdeck
FRONT_MATCHED_BODIES = ["Body347"]  # front_upperdeck
GUIDED_REAR_BODIES = ["Body356"]  # double_fan_support
TRANSMISSION_AXIAL_COMPONENTS = [
    ("Body172", "rear"),   # shaft_rear
    ("Body246", "rear"),   # pulley_rear
    ("Body253", "front"),  # shaft_front_hollow_petcf
    ("Fusion006", "front"),  # pulley_front_capped
]
FRONT_TOWERS = [
    ("Body255", -20.0),  # tower_right
    ("Body262", 20.0),   # tower_left
]


def placement_record(placement):
    q = placement.Rotation.Q
    return {
        "base_mm": [round(placement.Base.x, 6), round(placement.Base.y, 6), round(placement.Base.z, 6)],
        "quaternion_xyzw": [round(float(value), 9) for value in q],
    }


def add_shape(target_doc, source_obj, normalized_shape, status, group, object_name=None):
    feature = target_doc.addObject("PartDesign::Feature", object_name or source_obj.Name)
    feature.Label = source_obj.Label
    feature.Shape = normalized_shape
    feature.addProperty("App::PropertyString", "SourceObject", "Assembly metadata")
    feature.SourceObject = source_obj.Name
    feature.addProperty("App::PropertyString", "PlacementStatus", "Assembly metadata")
    feature.PlacementStatus = status
    group.addObject(feature)
    return feature


def main():
    args = list(sys.argv)
    try:
        passed = args[args.index("--pass") + 1 :]
    except ValueError:
        passed = args[1:]
    if len(passed) != 2:
        raise SystemExit("Usage: freecadcmd SCRIPT --pass SOURCE.FCStd OUTPUT.FCStd")

    source_path = Path(passed[0]).expanduser().resolve()
    output_path = Path(passed[1]).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    source = App.openDocument(str(source_path))
    target = App.newDocument("rc_car_core_assembly")
    assembly = target.addObject("App::Part", "CoreAssembly")
    assembly.Label = "RC car core assembly"
    exact_group = target.addObject("App::DocumentObjectGroup", "ExactPlacements")
    exact_group.Label = "Validated placements from source joints"
    provisional_group = target.addObject("App::DocumentObjectGroup", "ProvisionalPlacements")
    provisional_group.Label = "Provisional placements to validate"
    inferred_group = target.addObject("App::DocumentObjectGroup", "InferredPlacements")
    inferred_group.Label = "Placements inferred from bearing axes"
    reference_group = target.addObject("App::DocumentObjectGroup", "ReferenceComponents")
    reference_group.Label = "Reference components for envelope validation"
    assembly.addObject(exact_group)
    assembly.addObject(provisional_group)
    assembly.addObject(inferred_group)
    assembly.addObject(reference_group)

    chassis_link = source.getObject("chassis_4mm")
    normalize = chassis_link.Placement.inverse()
    manifest = []

    for name in EXACT_LINKS:
        source_obj = source.getObject(name)
        shape = source_obj.Shape.copy()
        shape.Placement = normalize.multiply(shape.Placement)
        feature = add_shape(target, source_obj, shape, "exact-source-joint", exact_group)
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
                "placement": placement_record(feature.Shape.Placement),
            }
        )

    # The authored rear upper deck already shares the source assembly's tilt.
    # Removing the chassis tilt places it in the normalized chassis coordinate system.
    for name in PROVISIONAL_BODIES:
        source_obj = source.getObject(name)
        shape = source_obj.Shape.copy()
        shape.Placement = normalize.multiply(shape.Placement)
        feature = add_shape(target, source_obj, shape, "provisional-authored-placement", provisional_group)
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
                "placement": placement_record(feature.Shape.Placement),
            }
        )

    # Four front-upper-deck holes match the chassis hole pattern in XY. The
    # user clarified that it belongs above the central divider between LiPos.
    for name in FRONT_MATCHED_BODIES:
        source_obj = source.getObject(name)
        shape = source_obj.Shape.copy()
        lipo_divider = target.getObject("lipo_holder_flex")
        support_top_z = lipo_divider.Shape.BoundBox.ZMax
        z_offset = support_top_z - shape.BoundBox.ZMin
        offset = App.Placement(App.Vector(0.0, 0.0, z_offset), App.Rotation())
        shape.Placement = offset.multiply(shape.Placement)
        feature = add_shape(
            target,
            source_obj,
            shape,
            "user-guided-above-lipo-divider",
            provisional_group,
        )
        feature.addProperty("App::PropertyString", "InterfaceEvidence", "Assembly metadata")
        feature.InterfaceEvidence = "User-guided above central LiPo divider; 4 XY holes match near x=-170.28 mm"
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
                "placement": placement_record(feature.Shape.Placement),
                "z_offset_mm": round(z_offset, 6),
                "interface_evidence": feature.InterfaceEvidence,
            }
        )

    # The double fan holder sits on the top edge of the right rear shoulder.
    # Match their X centers, the holder's outer Y edge to the shoulder's outer
    # face, and the holder bottom to the shoulder top. This makes it extend
    # inwards over the car rather than outwards.
    for name in GUIDED_REAR_BODIES:
        source_obj = source.getObject(name)
        shape = source_obj.Shape.copy()
        shoulder = target.getObject("rear_tower_right")
        initial_box = shape.BoundBox
        rotation_center = App.Vector(
            (initial_box.XMin + initial_box.XMax) / 2.0,
            (initial_box.YMin + initial_box.YMax) / 2.0,
            initial_box.ZMin,
        )
        guided_rotation = App.Rotation(App.Vector(0.0, 0.0, 1.0), -90.0)
        shape.rotate(rotation_center, App.Vector(0.0, 0.0, 1.0), -90.0)
        fan_box = shape.BoundBox
        shoulder_box = shoulder.Shape.BoundBox

        # This pair is 25 mm apart in the authored fan-holder geometry and is
        # the mounting pair, not one of the fan screw patterns.
        authored_pair = [
            App.Vector(-52.308747, -7.810592, initial_box.ZMin),
            App.Vector(-52.308747, 17.189408, initial_box.ZMin),
        ]
        rotated_pair = [
            guided_rotation.multVec(point - rotation_center) + rotation_center
            for point in authored_pair
        ]
        rotated_pair.sort(key=lambda point: point.x)
        target_pair = [
            App.Vector(shoulder_box.XMin + 20.5, (shoulder_box.YMin + shoulder_box.YMax) / 2.0, shoulder_box.ZMax),
            App.Vector(shoulder_box.XMin + 45.5, (shoulder_box.YMin + shoulder_box.YMax) / 2.0, shoulder_box.ZMax),
        ]
        translation = target_pair[0] - rotated_pair[0]
        offset = App.Placement(translation, App.Rotation())
        shape.Placement = offset.multiply(shape.Placement)
        feature = add_shape(
            target,
            source_obj,
            shape,
            "user-guided-above-rear-right-shoulder",
            provisional_group,
        )
        feature.addProperty("App::PropertyString", "InterfaceEvidence", "Assembly metadata")
        feature.InterfaceEvidence = "User-guided; 25 mm fan-holder pair aligned to the two motor-mount holes"
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
                "placement": placement_record(feature.Shape.Placement),
                "translation_mm": [round(translation.x, 6), round(translation.y, 6), round(translation.z, 6)],
                "guided_rotation_deg_z": -90.0,
                "interface_evidence": feature.InterfaceEvidence,
            }
        )

    # The bearing bores define transverse axes. Authored shafts and pulleys use
    # local Z as their rotation axis, so rotate local Z onto global Y and align
    # their bounding-box centers to the corresponding bearing axis.
    rear_shoulder = target.getObject("rear_tower_right").Shape.BoundBox
    axes = {
        "rear": App.Vector(151.719549, 0.0, 29.0),
        "front": App.Vector(-83.8768, 0.0, 45.10),
    }
    for name, axis_name in TRANSMISSION_AXIAL_COMPONENTS:
        source_obj = source.getObject(name)
        shape = source_obj.Shape.copy()
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            (box.ZMin + box.ZMax) / 2.0,
        )
        shape.rotate(center, App.Vector(1.0, 0.0, 0.0), -90.0)
        rotated_box = shape.BoundBox
        rotated_center = App.Vector(
            (rotated_box.XMin + rotated_box.XMax) / 2.0,
            (rotated_box.YMin + rotated_box.YMax) / 2.0,
            (rotated_box.ZMin + rotated_box.ZMax) / 2.0,
        )
        translation = axes[axis_name] - rotated_center
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target,
            source_obj,
            shape,
            f"inferred-{axis_name}-bearing-axis",
            inferred_group,
        )
        feature.addProperty("App::PropertyString", "InterfaceEvidence", "Assembly metadata")
        feature.InterfaceEvidence = f"Aligned local Z axis to transverse {axis_name} bearing axis"
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
                "axis": axis_name,
                "axis_center_mm": [axes[axis_name].x, axes[axis_name].y, axes[axis_name].z],
                "interface_evidence": feature.InterfaceEvidence,
            }
        )

    # Place the two front towers on the symmetric vertical pivot locations.
    # Their authored main bore is centered at local x=3.5, y=0.
    front_pivot_x = -170.269
    tower_top_z = 4.0
    for name, target_y in FRONT_TOWERS:
        source_obj = source.getObject(name)
        shape = source_obj.Shape.copy()
        box = shape.BoundBox
        translation = App.Vector(
            front_pivot_x - 3.5,
            target_y,
            tower_top_z - box.ZMin,
        )
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target,
            source_obj,
            shape,
            "inferred-front-symmetric-pivot",
            inferred_group,
        )
        feature.addProperty("App::PropertyString", "InterfaceEvidence", "Assembly metadata")
        feature.InterfaceEvidence = f"Main vertical bore aligned at x={front_pivot_x}, y={target_y}"
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
                "translation_mm": [round(translation.x, 6), round(translation.y, 6), round(translation.z, 6)],
                "interface_evidence": feature.InterfaceEvidence,
            }
        )

    # The upper suspension reinforcement bridges the towers transversely.
    reinforce_obj = source.getObject("Body323")
    reinforce_shape = reinforce_obj.Shape.copy()
    reinforce_box = reinforce_shape.BoundBox
    reinforce_center = App.Vector(
        (reinforce_box.XMin + reinforce_box.XMax) / 2.0,
        (reinforce_box.YMin + reinforce_box.YMax) / 2.0,
        reinforce_box.ZMin,
    )
    reinforce_shape.rotate(reinforce_center, App.Vector(0.0, 0.0, 1.0), 90.0)
    rotated_box = reinforce_shape.BoundBox
    translation = App.Vector(
        front_pivot_x - (rotated_box.XMin + rotated_box.XMax) / 2.0,
        -(rotated_box.YMin + rotated_box.YMax) / 2.0,
        34.0 - rotated_box.ZMin,
    )
    reinforce_shape.Placement = App.Placement(translation, App.Rotation()).multiply(reinforce_shape.Placement)
    feature = add_shape(
        target,
        reinforce_obj,
        reinforce_shape,
        "inferred-bridge-above-front-towers",
        inferred_group,
    )
    feature.addProperty("App::PropertyString", "InterfaceEvidence", "Assembly metadata")
    feature.InterfaceEvidence = "Rotated across vehicle and centered on front pivot pair"
    manifest.append(
        {
            "name": feature.Name,
            "label": feature.Label,
            "status": feature.PlacementStatus,
            "interface_evidence": feature.InterfaceEvidence,
        }
    )

    # Two LiPo references sit on either side of the central divider.
    lipo_obj = source.getObject("Body086")
    for side, target_y in (("left", -27.5), ("right", 27.5)):
        shape = lipo_obj.Shape.copy()
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            box.ZMin,
        )
        translation = App.Vector(-4.0, target_y, 4.0) - center
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target,
            lipo_obj,
            shape,
            "reference-two-lipo-layout",
            reference_group,
            f"lipo_{side}",
        )
        feature.Label = f"LiPo {side}"
        manifest.append(
            {
                "name": feature.Name,
                "label": feature.Label,
                "status": feature.PlacementStatus,
            }
        )

    def add_axial_wheel(source_name, object_name, target_center):
        wheel_obj = source.getObject(source_name)
        shape = wheel_obj.Shape.copy()
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            (box.ZMin + box.ZMax) / 2.0,
        )
        shape.rotate(center, App.Vector(1.0, 0.0, 0.0), -90.0)
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            (box.ZMin + box.ZMax) / 2.0,
        )
        translation = target_center - center
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target,
            wheel_obj,
            shape,
            "reference-wheel-axis-envelope",
            reference_group,
            object_name,
        )
        manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    add_axial_wheel("Body060", "wheel_rear_left", App.Vector(151.719549, -78.9, 29.0))
    add_axial_wheel("Body060", "wheel_rear_right", App.Vector(151.719549, 78.9, 29.0))
    add_axial_wheel("Body068", "wheel_front_left", App.Vector(-170.269, -91.4, 29.0))
    add_axial_wheel("Body068", "wheel_front_right", App.Vector(-170.269, 91.4, 29.0))

    def add_axial_component(source_name, object_name, target_center, status, group):
        source_obj = source.getObject(source_name)
        shape = source_obj.Shape.copy()
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            (box.ZMin + box.ZMax) / 2.0,
        )
        shape.rotate(center, App.Vector(1.0, 0.0, 0.0), -90.0)
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            (box.ZMin + box.ZMax) / 2.0,
        )
        shape.Placement = App.Placement(target_center - center, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(target, source_obj, shape, status, group, object_name)
        manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    # Rear spur and motor pinion use parallel Y axes. Their pitch envelopes
    # imply an approximately 36 mm center distance.
    motor_axis = App.Vector(115.719549, 0.0, 29.0)
    rear_gear_plane_y = 27.0
    add_axial_component(
        "Body090", "motor_reference", motor_axis,
        "inferred-motor-under-double-fan-holder", reference_group,
    )
    add_axial_component(
        "Body171", "spur_49t_assembled", App.Vector(151.719549, rear_gear_plane_y, 29.0),
        "inferred-rear-shaft-gear-plane", inferred_group,
    )
    add_axial_component(
        "Body229", "spur_holder_assembled", App.Vector(151.719549, rear_gear_plane_y, 29.0),
        "inferred-rear-shaft-gear-plane", inferred_group,
    )
    add_axial_component(
        "Body133", "pinion_assembled", App.Vector(115.719549, rear_gear_plane_y, 29.0),
        "inferred-motor-gear-mesh", inferred_group,
    )

    # Current LiPo retaining pieces (legacy variants remain excluded).
    for source_name, object_name, translation in (
        ("Body341", "lipo_lateral_blocker_assembled", App.Vector(0.0, 0.0, 4.0)),
        ("Body329", "front_lipo_link_long_assembled", App.Vector(0.0, 0.0, 9.0)),
        ("Body340", "lipo_barrier_front_right", App.Vector(0.0, 0.0, 4.0)),
    ):
        source_obj = source.getObject(source_name)
        shape = source_obj.Shape.copy()
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target, source_obj, shape, "authored-current-lipo-layout", inferred_group, object_name
        )
        manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    # Mirror the single authored front barrier for the second LiPo bay.
    barrier_obj = source.getObject("Body340")
    barrier_shape = barrier_obj.Shape.copy()
    barrier_shape.mirror(App.Vector(0.0, 0.0, 0.0), App.Vector(0.0, 1.0, 0.0))
    barrier_shape.Placement = App.Placement(App.Vector(0.0, 0.0, 4.0), App.Rotation()).multiply(
        barrier_shape.Placement
    )
    feature = add_shape(
        target,
        barrier_obj,
        barrier_shape,
        "mirrored-current-lipo-layout",
        inferred_group,
        "lipo_barrier_front_left",
    )
    manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    def add_horizontal_cross_part(source_name, object_name, target_x_center, target_z_min):
        source_obj = source.getObject(source_name)
        shape = source_obj.Shape.copy()
        box = shape.BoundBox
        center = App.Vector(
            (box.XMin + box.XMax) / 2.0,
            (box.YMin + box.YMax) / 2.0,
            box.ZMin,
        )
        shape.rotate(center, App.Vector(0.0, 0.0, 1.0), 90.0)
        box = shape.BoundBox
        translation = App.Vector(
            target_x_center - (box.XMin + box.XMax) / 2.0,
            -(box.YMin + box.YMax) / 2.0,
            target_z_min - box.ZMin,
        )
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target,
            source_obj,
            shape,
            "inferred-chassis-edge-cross-member",
            inferred_group,
            object_name,
        )
        manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    # Main front bumper and its narrower holder occupy the 44/45 mm region
    # immediately ahead of the chassis nose. The rear body holder is centered
    # just behind the rear edge.
    add_horizontal_cross_part("Body230", "bumper_holder_assembled", -211.253463, 4.0)
    add_horizontal_cross_part("Body186", "bumper_assembled", -232.753463, 4.0)
    add_horizontal_cross_part("Body198", "bodyshell_rear_holder_assembled", 181.719549, 4.0)

    # Steering bellcranks: align their authored 14 mm main bores to the two
    # chassis steering pivot locations.
    steering_pivots = [
        ("Body305", "steering_bellcrank_left", App.Vector(-43.75, 16.0, 0.0), App.Vector(-100.8092, -36.0, 4.0)),
        ("Body306", "steering_bellcrank_right", App.Vector(-9.25, 16.0, 0.0), App.Vector(-100.8092, 13.0, 4.0)),
    ]
    for source_name, object_name, authored_pivot, target_pivot in steering_pivots:
        source_obj = source.getObject(source_name)
        shape = source_obj.Shape.copy()
        box = shape.BoundBox
        translation = App.Vector(
            target_pivot.x - authored_pivot.x,
            target_pivot.y - authored_pivot.y,
            target_pivot.z - box.ZMin,
        )
        shape.Placement = App.Placement(translation, App.Rotation()).multiply(shape.Placement)
        feature = add_shape(
            target,
            source_obj,
            shape,
            "inferred-chassis-steering-pivot",
            inferred_group,
            object_name,
        )
        manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    # The authored ESC plate already has the correct XY envelope behind the
    # LiPos. Raise it to the pack-top plane.
    esc_obj = source.getObject("Body320")
    esc_shape = esc_obj.Shape.copy()
    esc_translation = App.Vector(0.0, 0.0, 29.0 - esc_shape.BoundBox.ZMin)
    esc_shape.Placement = App.Placement(esc_translation, App.Rotation()).multiply(esc_shape.Placement)
    feature = add_shape(
        target,
        esc_obj,
        esc_shape,
        "inferred-above-rear-lipo-area",
        inferred_group,
        "esc_plate_rear_assembled",
    )
    manifest.append({"name": feature.Name, "label": feature.Label, "status": feature.PlacementStatus})

    target.recompute()
    target.saveAs(str(output_path))
    manifest_path = output_path.with_suffix(".json")
    manifest_path.write_text(
        json.dumps(
            {
                "source": str(source_path),
                "assembly": str(output_path),
                "normalization": placement_record(normalize),
                "components": manifest,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"Created {output_path} with {len(manifest)} components")
    App.closeDocument(target.Name)
    App.closeDocument(source.Name)


main()
