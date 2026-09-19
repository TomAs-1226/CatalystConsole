# Changelog

All notable changes to Catalyst Console are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-09-19 — The team's own robot, drawn and driven, on a Tesla-style board

### Added

- **Park** is now a Tesla Model 3–style garage screen: the team's own robot stands there, posed
  from its CAD and telemetry, and the board shifts out of Park into Drive the moment the robot
  enables — with a driver figure, in a helmet with folded arms, standing beside it and choosable
  by profile.
- **The field view draws the team's own robot** instead of a placeholder box, baked from its CAD
  (about 120k triangles) with the hood, intake, rollers, flywheel and hopper posed live from
  telemetry.
- **FUEL is drawn as a visualization**, not a simulation: packed in the hopper the way balls
  settle, launched in volleys when the robot shoots, only shown once a piece is really picked up,
  and a lob now lands on a feed spot at the time of flight the robot publishes.
- **A Shooter tile** says whether a shot could go now and why not, with the aim shown as a HUB
  heads-up, fading trails, and the aim's error broken out by how fast the robot was moving.
- **OVERDRIVE** — a Tesla Plaid–style badge and sweep in the field view when the robot reports a
  speed boost engaged.
- Calibration runs now show their progress and result as quiet grey capsules, the way Tesla shows
  calibration status.
- **Run review** writes up every test session and judges it by numbers, so a session is not just
  watched but recorded.
- **A CAN view** groups the five CAN buses by the SPI controller they share, and a new
  **Systemcore page in Settings** reports what the machine says about itself.
- **Motor history and Autonomy 2.0 tiles**, reading `/Catalyst/MotorHistory` and
  `/Catalyst/Autonomy` respectively.
- The console now reads the Systemcore's own on-device agent when one is present, and reads the
  2027 Driver Station's logs alongside the NI ones.
- The notice bar now reads as one card and opens straight to the Devices page.

### Changed

- The whole console was redrawn after Tesla's in-car screens: a monochrome palette, and Settings,
  pop-ups and sheets now behave like Tesla's Controls screen rather than only looking like it.
- Catalyst 2.x's auto chooser moved to `/Auto Selector`, and the console's controller-key names and
  garage demo robot were updated to match what Catalyst 2.x actually publishes.
- A tile's state now reads as a word instead of a stripe, a rule or amber digits, and the status
  bar gives up whole words rather than clipping them.
- The field view now stops repainting when nothing has changed, so an idle board costs nothing.
- The camera model in the field view is now drawn from the vendor's own CAD.
- The console now looks for a Systemcore before a roboRIO, and pins CAN utilisation instead of
  drawing past 100%.

### Fixed

- The Systemcore page in Settings was rebuilding itself sixty times a second; it now updates only
  when its data changes.
- `package-lock.json` trailed the version every other file carried, and the version files can now
  disagree with each other only by failing the test run.
- An empty tile now says what it is waiting for, and a robot connection failure is logged once
  instead of every cycle.
- The CAD robot's polycarbonate panels read as cut-apart layers rather than glass; they are now
  drawn as a single glass layer so a ball behind them reads correctly.

## [1.0.0] — 2026-08-07 — Ready for the field.

## [0.8.1] — 2026-08-06 — Devices is its own section.

## [0.8.0] — 2026-08-06 — Less text, more robot.

## [0.7.0] — 2026-08-06 — Search, release notes, and documentation that is true.

## [0.6.0] — 2026-08-06 — What the robot is made to do.

## [0.5.1] — 2026-08-06 — The garage, properly.

## [0.5.0] — 2026-08-06 — Settings, and the robot's own spec sheet.

## [0.4.0] — 2026-08-06 — About page, layout portability, shortcuts, connection history, a read-only diagnostics MCP.

## [0.3.0] — 2026-08-06 — In-place updates.

## [0.2.0] — 2026-08-05 — Impacts and swerve tiles.
