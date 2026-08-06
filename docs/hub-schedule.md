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

## Where the console gets it

`/FMSInfo/GameSpecificMessage` is a single character, `R` or `B`, naming the alliance whose goal
goes inactive first. It is **empty until roughly three seconds after auto ends**, once fuel scoring has
been assessed.

That is why the tile says *waiting for FMS game data* early in a match rather than guessing. During
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