# CAN buses

Systemcore has five CAN buses, and they are not five independent lanes. They are MCP2518FD
controllers on three shared SPI hosts: `can_s0` and `can_s1` on one, `can_s2` alone, `can_s3` and
`can_s4` on a third. Two buses on one host throttle each other. Two on different hosts do not.

Nothing else in the FRC toolchain draws that distinction — on paper all five read as equals. So a
team moving half a drivetrain off a loaded bus can pick the pair that buys them nothing, and find out
about it on a field. That grouping is the whole reason the **CAN** tab is a view of its own rather
than another row on the Systemcore page.

| Controller | Buses | |
| --- | --- | --- |
| Controller 1 | `can_s0`, `can_s1` | two buses, one SPI host |
| Controller 2 | `can_s2` | one bus, nothing to share with |
| Controller 3 | `can_s3`, `can_s4` | two buses, one SPI host |

The pairing is read out of the Systemcore OS image and encoded in the library at
`CatalystCANBus.controllerGroup()`. `src/can-model.js` is the console's copy of it, and the group ids
match exactly, so a warning raised here and a warning raised on the robot are talking about the same
controller.

A CANivore brings its own controller and shares with nothing above, so it lands in one extra group at
the bottom — and only when it actually carries a device. Pretending a CANivore hangs off one of
Systemcore's three hosts would be inventing hardware.

## The pair figure

Each shared controller draws one combined bar above its two buses. That number is what the grouping
exists to show: two buses at 55% each look fine one at a time, and together exceed what their SPI
host can carry.

It is drawn against **100% of the pair**, not 200%. The ceiling is one controller's throughput rather
than the sum of two free wires — `CANBusPlanner.TARGET_PAIR_UTILIZATION`. The bar clamps at its
track; the number beside it keeps saying the real figure, because a combined reading legitimately
goes past what the pair should carry, and a bar wider than its track is a layout bug rather than a
reading.

A pair total is **absent unless both its buses were measured**. Half a reading would render as a low
one, and a missing number that looks low in one place and like a dash in another is the single thing
this page cannot afford.

## What the console works out, and what the robot said

Two blocks of warnings, kept apart and labelled, because they are not equally current.

**What the console works out** is computed client-side from what is on the wire right now, every
frame. Four rules:

| | Level |
| --- | --- |
| A bus carries more than **12 devices** | warn |
| A bus is measured past **90%** | crit |
| A shared pair carries more than **12 devices** between them, both buses in use | warn |
| A shared pair's combined utilisation passes **100%** | crit |

The last two are the ones that hide. Twelve devices split across `can_s0` and `can_s1` are still
twelve devices on one controller, and both cases read on paper as "they are on different buses". The
pair count rule only fires when both buses actually carry something — with everything on one of them
the single-bus rule has already said it, and the advice differs: move devices onto an *unpaired* bus
rather than shuffling them between these two.

Two of the four rules use device counts and two use measured utilisation, and that split is
deliberate. **Counts are knowable with the robot disabled**, which is when somebody is standing in
front of it able to move a wire. Utilisation is only true under load and says nothing at rest.

90% is `CANBusHealth.UTILIZATION_WARN`, the figure Systemcore's own web UI warns at. Matching the OS
is on purpose: a team that sees a warning in one place and not the other will reasonably assume one
of them is broken. 12 is the `busyThreshold` inside `CANRegistry.contentionWarnings()`, where the
library is explicit that device count is a rough proxy for load.

Bars colour before the warnings fire — a bus goes amber at 70% and red at 90%, a pair at 80% and 100%
of its limit — so a bus on its way up is visible before it has anything to say.

**What the robot said** is the CAN half of the robot's own preflight, out of
`/Catalyst/Preflight/Findings`: the findings titled *CAN plan* (`CANBusPlanner.validate`) and *CAN
layout* (`CANRegistry.contentionWarnings`). Preflight has plenty to say about storage and battery and
the command runtime, and none of it belongs on a page about CAN buses.

It sits in its own block under *From the robot's preflight* because it is a snapshot from whenever
robot code last called `Preflight.run()`, and nothing republishes it. A finding sitting beside a live
warning would be read as equally current.

## Where the numbers come from

| Topic | What it carries | Published by |
| --- | --- | --- |
| `/Catalyst/CAN/Devices` | what is wired where, one line per device | `CANRegistry.republish()` |
| `/Catalyst/Systemcore/CanUtilization` | the OS's own measurement, all five buses, always | `SystemCoreStatus.publish()` |
| `/Catalyst/CAN/Health/<bus>/*` | Phoenix's view — reaches CANivores, carries the error counters | `CANBusHealth.publish()` |
| `/Catalyst/Preflight/Findings` | what the robot said about its own CAN plan, when it last ran | `Preflight.run()` |

The first three are continuous. The fourth is not, which is why it is fenced off above.

**Two sources measure utilisation and they are not interchangeable.** The OS array covers all five
buses whether or not the robot registered a device on them, which is what makes an empty bus visibly
empty rather than merely unmentioned. Phoenix's reading reaches CANivores, which the OS array cannot,
and carries the error counters, which it does not.

The OS figure wins for a Systemcore bus, because the Systemcore page already draws that number and
two surfaces of one console disagreeing about one bus is worse than either being slightly stale.
Phoenix fills in everywhere the OS cannot reach, and a bus whose number came from Phoenix says
`· Phoenix` on its meta line — so a reader can see why two figures differ rather than guessing.

A device row is `bus|canId|type|name`, written by `CANRegistry.Entry.serialize()`. The name is last
because it is a string a team wrote and can contain a pipe of its own; everything past the third
separator belongs to the name and is put back together. A row with no numeric id is dropped rather
than shown as a device with holes in it — it is not a partial reading, it is a line the console does
not understand.

Bus names are normalised on the way in, because `""`, `"0"` and `"can_s0"` are three spellings of one
physical bus. A current library normalises before it publishes, but a console outlives a robot's
library version and a 1.x robot publishes the raw string it was given. Two spellings of one wire
would split it into two half-loaded buses on screen.

The **Devices** page also lists CAN devices, from the spec sheet's own roster — see
[Settings → Devices](settings.md#devices). That answers *what is on this robot*. This page answers
*what will fight what*.

## Absent is not zero

The rule that runs through the whole console ([rule 3](../README.md#the-three-rules)) is the one this
page is most able to blur, because a bus nobody measured and a bus carrying nothing both draw an
empty track.

| On screen | What it means |
| --- | --- |
| `—` · *not measured* | nobody reported on that wire |
| `0%` · *idle* | it was measured, and it is carrying nothing (below 1%) |

They are separated in the text and in the styling. Reading "0%" off a bus that was never reported on
is how somebody concludes a wire is free and hangs a mechanism on it.

The topology is drawn **with no robot attached at all**. Five buses on three controllers is a fact
about the Systemcore rather than a reading from one, and an empty bus is the most useful thing on
this page — it is where the next mechanism should go. A view that only listed buses somebody had
already used could not show that. Every number stays a dash until something answers.

## Error counters

A bus does not go from healthy to bus-off. The receive and transmit error counters climb first, and
**128** is where a CAN controller enters error-passive — `CANBusHealth.BusStatus.hasErrorActivity()`,
same threshold. At or past it the bus's meta line reads `errors REC 140 / TEC 0`. Bus-off events and
TX queue overflows are counted on the same line, as `bus-off ×2` and `TX full ×5`.

Catching that in the pit is the difference between finding a loose connector and finding it during an
elimination. It needs Phoenix health on the bus, since the OS utilisation array carries no counters.

## What it deliberately does not do

`CANBusPlanner`'s frames-per-second estimate is not ported. It prices a device from a table of
Phoenix status-signal rates that changes with firmware and with whatever a team configured, and the
library is explicit that it is conservative guesswork meant to be calibrated against a real
measurement. Putting a guess at load next to the measured figure would be the console inventing a
number it can see the real value of.

Nothing on this page writes to the robot, moves a device, or changes a CAN id. It says which bus is
carrying what and which two buses are in each other's way; the wiring and the ids are yours.
