# The diagnostics MCP server

Catalyst Console can run as a **read-only diagnostics server** instead of a dashboard. Start it with
`--mcp` and it opens no window at all: it connects to NetworkTables exactly as the dashboard does and
speaks the Model Context Protocol on stdin and stdout, so an agent can ask what the robot is
publishing rather than a human reading numbers off a screen and typing them somewhere else.

```bash
catalyst-console --mcp
catalyst-console --help     # both modes, explained by the binary itself
```

## There is no drive tool, and there will not be one

Every tool here reads. None writes.

That is the first of [the three rules](README.md#the-three-rules) holding, not a feature nobody got
round to. FRC requires the official NI Driver Station and only one DS may hold the robot connection.
A tool that could enable, disable, or drive would be a **second control path to a robot** — the one
thing this product must not have, and the reason there is no code path anywhere in it that opens
that socket.

So: no `enable`, no `drive`, no `estop`, and no `nt_set` either. The dashboard's own NetworkTables
write path exists for tunables and auto choosers, it is guarded against the `/FMSInfo` namespace, and
it is deliberately not reachable from `mcp.rs`. If you are reading this because you were about to add
one, the answer is no — and `src-tauri/src/mcp.rs` says so where you would be tempted.

What the server is for is the other half of the problem: an agent that can *see* the robot's state
can diagnose it, and diagnosis has never needed control.

## Pointing an agent at it

The server is an ordinary stdio MCP server, so anything that speaks MCP can spawn it.

Claude Code:

```bash
claude mcp add catalyst -- "C:/Program Files/Catalyst Console/catalyst-console.exe" --mcp
```

Or by configuration, in the shape most clients use:

```json
{
  "mcpServers": {
    "catalyst": {
      "command": "C:/Program Files/Catalyst Console/catalyst-console.exe",
      "args": ["--mcp"]
    }
  }
}
```

From a source checkout the binary is at `src-tauri/target/debug/catalyst-console.exe` after
`cargo build`.

**Which robot it looks for.** The same four candidate addresses the dashboard cycles — localhost,
`roborio-TEAM-frc.local`, the pit static IP, and the USB tether — using the team number the dashboard
saved in its settings. On a machine where the dashboard has never run there are no settings, so pass
`--team 1234` in `args` to say which robot you mean.

**Running it alongside the dashboard is fine.** They are two NetworkTables *clients*, which is
ordinary — Shuffleboard and Glass coexist the same way. What must not be duplicated is the Driver
Station, and neither of them is one.

## The tools

| Tool | Answers |
| --- | --- |
| `console_status` | version, whether NT is connected, which address answered, RTT, topic count, uptime |
| `nt_list` | topic names, optionally filtered by substring — what exists |
| `nt_get` | one topic's current value and type |
| `alerts` | errors, warnings and info from the robot's alert group |
| `physics` | Physics Core pose, slip, tipping, traction, confidence |
| `match_state` | enabled, mode, E-stop, alliance, match time, FMS game-specific message |
| `ds_sessions` | Driver Station log sessions on this machine, newest first |
| `ds_events` | one session's events — radio drops, brownouts, watchdog trips |
| `field_map` | whether a field collision map is present, and its metadata |

Start with `console_status`. Every other tool reads more usefully once you know whether there is a
robot on the other end.

### Absent is not zero

The third rule applies here more than anywhere, because an agent cannot see the dash a driver would.
A tile that shows `—` is obviously empty; a tool that returns `0.0` is confidently wrong, and an
agent will act on it.

So every value carries whether it was actually published:

```json
{ "published": false, "value": null, "topic": "/Catalyst/Physics/TippingUsage" }
```

The distinctions the tools are careful about:

* **`alerts` returns `null`, not `[]`, when the alert group is missing.** An empty list reads as "all
  clear", which is the most dangerous wrong answer this server could give. A missing group means the
  question was not answered, not that the robot is healthy.
* **`match_state.mode` is `null` without a control word**, not `"Disabled"`. A robot nobody is
  hearing from is not a robot that is disabled.
* **An empty game-specific message is published-and-empty**, which is different from absent — FMS
  sends it at the start of teleop, and the hub schedule depends on telling those apart.
* **`console_status.rtt_ms` is `null` while disconnected.** A round trip measured on a link that has
  since dropped is a stale number, not a current one.
* **NaN comes back as the string `"NaN"`**, with the type still reported as `double`. JSON has no NaN
  and serialisers turn it into `null` — which in this server means "not published". An
  uninitialised estimator publishes NaN often enough that conflating the two would be a real
  misreading.
* **`ds_events` distinguishes a quiet session from an unreadable file.** The `.dslog` formats are
  community-reverse-engineered rather than documented by NI, so a header the parser does not
  recognise is reported as unparsed rather than decoded into plausible nonsense.
* **`field_map` says which paths it searched** when there is no map. The map is generated from the
  field CAD by `npm run field-collision` and is deliberately not committed, so a fresh checkout and
  an installed build both legitimately lack one.

### A worked call

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"physics","arguments":{}}}
```

```json
{
  "present": true,
  "pose": { "published": true, "x_m": 3.21, "y_m": 1.94, "theta_rad": 0.7531 },
  "slip_factor": { "published": true, "value": 0.1412 },
  "tipping_usage": { "published": true, "value": 0.3107 },
  "traction_usage": { "published": true, "value": 0.6218 },
  "confidence": { "published": true, "value": 0.9104 },
  "reading": "slip, tipping and traction are all the fraction of a limit in use ... higher is worse",
  "advisory": "Physics Core has been validated in simulation and has never run on carpet ..."
}
```

The advisory travels with the numbers on purpose. The Physics Core tile says *advisory only* on its
face for a driver; an agent reading the same values deserves the same warning, and unlike a driver it
cannot see the tile.

## What it speaks

JSON-RPC 2.0 over stdio, one JSON object per line: `initialize`, `tools/list`, `tools/call`, and
`ping`. Protocol revisions `2024-11-05`, `2025-03-26` and `2025-06-18` are all answered.

It is implemented directly in `src-tauri/src/mcp.rs` with no MCP SDK. The surface a server this small
needs is a few hundred lines, and a dependency for it would be more code to audit than the code it
replaces, in a binary that ships to a driver station laptop.

**stdout carries protocol frames and nothing else**, because anything else on it corrupts the
stream. Diagnostics for humans, and the NetworkTables client's own logging, go to stderr.

You can drive it by hand:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | catalyst-console --mcp
```

## Failure

The same way as everything else here: quietly, and without lying.

No robot is the normal state for most of a day, and it is not an error — the tools answer with
`connected: false` and report the absence of each value rather than failing the call. The
NetworkTables client reconnects on its own forever, so a server started before the robot is powered
on picks it up when it appears, with nothing to restart.
