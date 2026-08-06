# Widgets

Every tile binds to NetworkTables keys you choose, so none of this is hard-coded to a season or a
robot. Add, remove, resize and rearrange from the dock; the layout is remembered.

## Match

| Widget | What it shows |
| --- | --- |
| **Match timer** | phase, shift name, countdown, and the shape of the match as three bars |
| **Hub activation** | whether your alliance hub is scoring, and how long until that changes |
| **Auto chooser** | pick the routine — writes the key `SendableChooser` reads |

The hub tile works the schedule out from the rules plus the FMS game-specific message rather than
needing the robot to tell it. See [the hub schedule](hub-schedule.md).

## Telemetry

| Widget | What it shows |
| --- | --- |
| **Gauge** | any numeric topic as an arc, dial, bar or number |
| **Swerve modules** | four module angles and speeds, drawn as they are actually pointing |
| **Graph** | rolling plot of one topic |
| **Value** | one topic, large, whatever its type |
| **Indicators** | a row of booleans as lamps |

### The gauge

One tile takes one topic or several comma-separated. With several, labels come from the shortest path
suffix that actually distinguishes them — four keys ending in `/Velocity` come out as FrontLeft /
FrontRight / BackLeft / BackRight rather than "Velocity" four times.

`Multiply by` exists because Phoenix 6 reports rotations per second; ×60 gives RPM.

## Health

| Widget | What it shows |
| --- | --- |
| **Battery** | voltage, rolling history, and measured sag |
| **Loop & bus** | loop time against budget, CAN utilisation, round-trip time |
| **Alerts** | whatever the alert manager is raising |
| **Physics Core** | slip, tipping and traction headroom |
| **Impacts** | contacts Physics Core detected, how hard and how long ago |

Alerts are held for a couple of seconds after they clear, dimmed. Anything edge-triggered on a
measurement sitting near its threshold raises and clears repeatedly, and rendering that verbatim gives
a tile that strobes next to a driver.

## Field

**Field view** puts the robot on the field in 3D from the pose estimator, with a heading wedge, a
trail, and bumpers in your alliance colour. Three cameras: chase, overhead, free orbit. The chase
camera swings around field elements that block the line of sight rather than leaving you looking at
the back of a truss.

## Pit

**Stopwatch** for cycle timing. **Note** for text that stays with the layout.

## Writing your own

The registry in `src/app.js` takes a config schema, a `render` that builds DOM once, and an
`update` called each frame. `update` must be cheap and must not throw — one bad tile cannot be
allowed to take out the board, and the paint loop enforces that.