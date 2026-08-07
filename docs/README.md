# Catalyst Console

A driver station companion for teams running [FrcCatalyst](https://github.com/TomAs-1226/FrcCatalyst).

- **[Installing](installing.md)** — with the desktop app, standalone, or from source
- **[Settings](settings.md)** — the panel, its six sections, and searching it
- **[The garage](robot-identity.md)** — the spec sheet a robot publishes about itself
- **[Widgets](widgets.md)** — what each tile shows and how to write your own
- **[The hub schedule](hub-schedule.md)** — REBUILT shifts, and where the console gets them
- **[The diagnostics MCP server](mcp.md)** — `--mcp`, what it exposes, and why it cannot drive
- **[The contract with the robot](../README.md#the-contract-with-the-robot)** — every key it reads

## The three rules

Everything here answers to these, in order.

1. **It never controls the robot.** FRC requires the official NI Driver Station and only one DS may
   hold the robot connection. There is no code path here that opens that socket.
2. **Nothing it does may impede driving.** No modal blocks the dashboard, no check gates anything.
   Every failure degrades to a dimmed number and a quiet chip in a corner.
3. **It never invents a number.** An unpublished topic shows a dash. The `.dslog` parser refuses
   versions it does not recognise rather than decoding them into nonsense.