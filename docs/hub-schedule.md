# The hub schedule

In REBUILT your alliance HUB stops scoring for part of teleop. The console works out when from the
rules and the FMS game data, so the robot does not have to tell it.

Terminology first, because the manual is specific and getting it backwards on a competition dashboard
is not a harmless nickname: the **HUB** is the fuel goal, and it is the thing that goes active and
inactive. The **TOWER** is the climbing structure in the alliance wall, with its three rungs.

## The segments

Teleop runs 140 s in six segments (2026 Game Manual, Table 6-2). The clock counts down, so each is
named by the time remaining when it ends.

| Segment | Time remaining | Hubs |
| --- | --- | --- |
| Transition shift | 2:20 – 2:10 | both active |
| Shift 1 | 2:10 – 1:45 | alternating |
| Shift 2 | 1:45 – 1:20 | alternating |
| Shift 3 | 1:20 – 0:55 | alternating |
| Shift 4 | 0:55 – 0:30 | alternating |
| End game | 0:30 – 0:00 | both active |

Through shifts 1–4 the alliance that scored **more fuel in AUTO** is inactive for shift 1, then they
alternate. On a tie, FMS picks one at random — so the game data always names an alliance.

## The countdown

The tile's countdown runs to the moment *this alliance's* hub actually changes, not to the end of the
segment the match is currently in — the two are different for the alliance that is active either side
of a boundary. An alliance active in shift 4 is also active through end game, so its countdown runs
straight through to the end of the match rather than warning at 0:30 that the hub is about to close.
The same goes at the start of teleop: the alliance that is active in shift 1 has been active since the
transition shift, so its countdown runs through that boundary too. Before the game-specific message
arrives, a countdown that crosses into a shift can only count to the segment boundary — the transition
shift counts down "until Shift 1" without saying which way the hub will go.

The countdown turns amber only in the last few seconds before a real change in this alliance's hub
state, never for a boundary that does not change anything for this alliance. Auto has no countdown at
all: both hubs score for the whole period by rule, so there is nothing to count down to.

## Where the console gets it

`/FMSInfo/GameSpecificMessage` is a single character, `R` or `B`, naming the alliance whose goal
goes inactive first. It is **empty until roughly three seconds after auto ends**, once fuel scoring has
been assessed.

That is why the caption under the tile's strip names the segment and where the state came from rather
than guessing — "Shift 2 · FMS", "Shift 1 · waiting for FMS", "Transition · both hubs", "Auto". During
shifts the answer genuinely depends on an auto result nothing else can infer. Auto, the transition
shift and end game need no game data at all — both hubs are active by rule, and the tile says so.

## The match clock

The console needs one, and **`/FMSInfo` does not carry it.** That table has the control word, the
alliance, the event and the game-specific message — but no time. Robot code has to publish it:

```java
CatalystLog.log("Match/TimeLeft", DriverStation.getMatchTime());
```

Without it the timer and the hub countdown show dashes rather than inventing a number.

## Overriding it

If your robot would rather compute the schedule itself, publish a boolean and a countdown and point
the tile at them in its settings. A robot-published answer always wins.