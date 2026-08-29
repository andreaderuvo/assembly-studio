# RC On-Road Catalog

Assembly Studio's catalog targets complete 1/10 and 1/8 on-road builds. Entries
must be useful for assembly work, not merely visual placeholders.

## Quality gate

Every released catalog family must provide:

- named parametric dimensions with realistic defaults and validated ranges;
- a recognizable WebGL preview before insertion;
- matching FreeCAD and STEP solid geometry;
- selectable mounting holes, shafts, seats, faces, and centers where applicable;
- editable variants after insertion without changing the component identity;
- portable-project, undo/redo, and export tests;
- scale, category, material, and compatibility metadata.

## Families

| System | Catalog families |
| --- | --- |
| Chassis | main decks, upper decks, radio trays, battery trays, braces, bumpers, body posts, mounts |
| Suspension | arms, hubs, C-hubs, steering blocks, caster blocks, shock towers, shocks, springs, anti-roll bars, droop screws |
| Steering | bellcranks, servo savers, racks, Ackermann plates, servo horns, ball studs, rod ends, turnbuckles |
| Drivetrain | spur gears, pinions, diffs, spools, outdrives, center shafts, dogbones, CVDs, universal shafts, wheel axles, drive pins |
| Transmission | belts, pulleys, gears, layshafts, slipper parts, motor mounts, bearing eccentrics |
| Wheels | rims, foam/rubber tires, inserts, wheel hexes, wheel nuts, adapters |
| Electronics | motors, ESCs, servos, receivers, transponders, fans, capacitors, switches, sensors |
| Power | LiPo packs, connectors, battery stops, straps, balance and power leads |
| Hardware | screws, shoulder screws, nuts, locknuts, washers, shims, spacers, bearings, e-clips, pins, set screws |
| Body/aero | touring and pan-car shells, wings, splitters, diffusers, body clips and magnetic mounts |

## Current verified foundation

- 1/8 and 1/10 brushless motor, ESC, servo, receiver, and LiPo families;
- ISO fasteners, hex bolts, and common RC bearing sizes;
- OpenSCAD-generated 4.8 mm ball studs and automatic adjustable turnbuckles
  whose plastic rod ends are centred on the installed balls;
- automatic driveshafts with transverse drive pins.

Catalog coverage is expanded family by family only after the quality gate above
passes. Generic boxes are allowed only when explicitly labelled as packaging or
clearance envelopes.
