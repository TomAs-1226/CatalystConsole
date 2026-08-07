# The garage

**Settings → Robot** shows the robot's own account of itself: its name, a plan of it drawn to scale,
and the specification it published. Nothing on it is typed in and nothing on it is configurable —
it fills in on its own the moment a robot that publishes a sheet connects, and stays blank when one
does not.

## What a team has to do

One line, at the top of `RobotContainer`:

```java
RobotIdentity.declare("Ratchet");
```

That is the whole adoption. FrcCatalyst 1.10 and later derives the rest: the team number, the season,
which roboRIO this is and its serial and image, its own version, WPILib's, the Java it is running,
the brownout threshold, the CAN inventory, the gyro — and, as soon as a `SwerveSubsystem` exists, the
drivetrain type, module count and positions, track width, wheelbase, odometry rate and top speed.

Two things on the sheet are not derived from the drivetrain, and it is worth knowing which. Gear
ratios come only from the module constants you hand to `.swerveModules(...)`, because Phoenix builds
a `SwerveDrivetrain` from them and will not hand them back. Mass and moment of inertia come from the
deployed PathPlanner settings; a project without them publishes neither.

None of that is passed in, and that is the point. Anything passed in can drift: a team that regears
its drive and forgets to edit an identity block publishes last month's robot with this month's
confidence.

A few facts no API can answer, so there is a builder for those:

```java
RobotIdentity.named("Ratchet")
    .robotCodeVersion(BuildConstants.GIT_SHA)
    .frameMeters(0.74, 0.74)
    .bumperThicknessMeters(0.08)
    .heightMeters(0.52)
    .swerveModules(TunerConstants.FrontLeft, TunerConstants.FrontRight,
                   TunerConstants.BackLeft, TunerConstants.BackRight)
    .power(pdh)
    .publish();
```

A tape measure is the only source for a frame perimeter, and only your own build knows which commit
the robot code came from. Everything in there is optional; leaving one out costs you that row and
nothing else.

Nothing has to be republished. NT4 keeps the last value of every topic and hands it to whoever
subscribes next, so a console that connects mid-match, or reconnects after the radio drops, gets the
sheet on connect. The library rewrites it when a new source of facts turns up — a drivetrain built
after `declare()`, a mechanism claiming CAN ids — so declaration order does not matter.

## What appears

The plan first, then the name with the team, the season and the controller model under it, then the
sheet grouped the way a spec sheet is read.

| Group | Rows |
| --- | --- |
| **Catalyst** | which parts of the library this robot runs — see below |
| **Software** | Catalyst version and commit, robot code version, build stamp, WPILib, Java |
| **Controller** | roboRIO model, serial, image, FPGA, the comment set in the Imaging Tool |
| **Drivetrain** | type, modules, top speed, rotation rate, track width, wheelbase, wheel radius, drive and steer ratios, odometry rate, CAN bus |
| **Chassis** | mass, moment of inertia, frame, bumper to bumper, diagonal, bumper depth, height |
| **Traction** | wheel grip, slip current, drive current limit |
| **Power** | battery, distribution module, channels used, brownout threshold |
| **Hardware** | CAN device count, motor and sensor inventory, gyro and its id, cameras |
| **Power channels** | every PDH channel the robot named, in channel order |

The CAN device tree and the power distribution panel used to sit under this sheet and now have
their own **Devices** section — see [settings.md](settings.md). The sheet keeps the counts,
because a count is the right shape for a glance and a tree is the right shape for a diagnosis.

Two of those are worked out here rather than read: the bumper **diagonal**, which is the width that
has to clear a gap on the angle, and **channels used**, which counts the named channels against the
module's total. Both are arithmetic on figures the robot published, and both disappear when either
side they are built from does.

The channel list at the bottom earns its place separately from the count. The count answers *how
loaded is the PDH*; the list answers *which breaker is the one that just popped*, and only the robot
knows that.

### What the robot is made to do

From FrcCatalyst 1.11 the sheet leads with a **Catalyst** group naming which parts of the library are
actually in use: Autopilot, Strategist, Sequence, Goal Director, Physics Core. Named instances are
listed where there are few enough to read; otherwise a count.

It leads because it is the part that distinguishes robots. Two machines can have identical
drivetrains and identical motor counts and be nothing alike, because one of them scores on its own
and the other does not, and no other row on the sheet says so.

Nothing in that group is declared. Each entry is written by the component at the moment it is
constructed — an autopilot is recorded because an autopilot was built. A list maintained by hand is a
list of what a team meant to use; this is a list of what came up, and when the two differ the second
is the one worth seeing on a driver station.

## Why a missing fact is missing rather than dashed

Everywhere else in this console an unpublished value shows a dash, because the tile is a fixed shape
and a driver needs to see that the number they expected is not there. The sheet is the one place that
rule points the other way.

A dash on a row labelled *Gyro* says **this robot has no gyro**. Absence says **it did not mention
one**. Only the second is ever true, because the console cannot tell a robot without a gyro from a
robot on an older library, or one whose sheet was written before the gyro was constructed. So a key
that did not arrive produces no row, and a group with nothing in it produces no group — a robot with
no swerve shows no drivetrain section rather than a column of zeros.

The library is built the same way round: a fact it does not know is absent from the wire, not zero,
not `-1`, not an empty string. Once a placeholder leaves the robot it is indistinguishable from a
measurement.

## The plan

Drawn from the figures on the wire — the bumper outline, the frame inside it, and a wheel at each
published module position, sized off the published wheel radius. Nose points up, which is +x in
WPILib's frame, and the brighter band across the front is which way that is.

It is drawn from measurements rather than picked from a set of stock pictures because wrong
dimensions look wrong. A team that has published a 30-inch frame should see a 30-inch frame.

Partial figures give a partial drawing rather than a confident wrong one. The caption says what it
was built from — *bumpers, frame, modules to scale* — so nobody reads one for the other:

* with no bumper figures the outer edge is drawn dashed, because the outer dimension is not known
* with no frame figures the deck inside is left out
* with module positions and nothing else the wheels are drawn inside a dashed outline taken from
  their own span, since that is the only outer dimension there is
* with none of the three there is no plan at all, and the card is just the sheet

**The bumpers are not drawn in your alliance colour**, alone among everything else on this dashboard
that has bumpers. Alliance is match state: it flips between matches and a team carries both sets. A
spec sheet that changed colour depending on when you happened to open it would be describing the
match rather than the machine, and the machine is the same robot on either side.

## Units

**Settings → Robot → Units** switches the sheet between metric and imperial. It is a display choice
and it stops at the sheet: the robot publishes SI, WPILib works in SI, and nothing on the wire
changes.

It is worth having because FRC writes its frame perimeter and height rules in inches. A team checking
whether they are legal would otherwise be converting metres by hand, which is a bad thing to be doing
at the moment it matters.

## Copying it out

**Copy the spec sheet** writes the whole thing to the clipboard as plain text, laid out in one
column, in whatever units are selected. At inspection someone is reading frame perimeter and weight
off a screen and writing them onto a form; this is that without the transcription step.

It is written from the same data the panel rendered rather than derived a second time, so the text
cannot disagree with what is on the screen. If the clipboard refuses — which a webview is entitled to
do — it says so rather than claiming a copy that did not happen.

## Seeing it without a robot

Switch on **Demo data**. The demo robot publishes a sheet in the shape the library does, named
*Demo robot* so nobody mistakes it for their own.

It is deliberately incomplete — no camera list, no drive ratio — because that is the ordinary case,
and the panel leaving those lines out is the behaviour worth demonstrating.
