# Graph Report - CatalystConsole  (2026-09-25)

## Corpus Check
- 93 files · ~283,075 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1702 nodes · 3663 edges · 87 communities (83 shown, 4 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 87 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3388f8c4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- field-collision.mjs
- nt4.rs
- main.rs
- robot-cad.mjs
- buildSettings
- app.js
- tauri.conf.json
- paintGarage
- dslog_tests.rs
- Hub activation tile
- onFrame
- el
- scripts
- definitions
- definitions
- setCamera
- update
- drivers.js
- hidePark
- Rule 2 — Nothing it does may impede driving
- paintLinkHistory
- properties
- properties
- Catalyst Console
- permissions
- permissions
- createField
- demo-match.js
- webviews
- webviews
- Rule 1 — It never controls the robot
- worldTriangles
- CapabilityRemote
- CapabilityRemote
- standDownOverlaysOnEnable
- paint
- vendor.mjs
- park3d.js
- Capability
- Capability
- desktop-schema.json
- windows-schema.json
- Rule 3 — It never invents a number
- serve.mjs
- description
- description
- isWall
- rasterEdge
- mechanisms.js
- runs.js
- escapeHtml
- can-model.js
- devices.js
- demo-match.test.js
- field3d.js
- driver3d.js
- robot3d.js
- robot-cad.js
- device-cad.mjs
- aim-target.test.js
- runs.test.js
- Changelog
- wpilog_tests.rs
- device3d.js
- hub.js
- calibration.js
- paintRunList
- hopper3d.js
- finite
- robot-cad-preview.mjs
- demoMatch
- motion.js
- AGENTS.md: Catalyst Console
- CAN buses
- check-identity.mjs
- driver-cad.mjs
- reviveRun
- core-format.js
- overdrive.js
- version-files.test.js
- The team number lives in the backend config
- drawRunTraces
- runFileName
- shots3d.js
- The plan, drawn from the wire

## God Nodes (most connected - your core abstractions)
1. `update()` - 55 edges
2. `main()` - 48 edges
3. `escapeHtml()` - 31 edges
4. `buildSettings()` - 30 edges
5. `Nt4Client` - 24 edges
6. `Rule 3 — It never invents a number` - 24 edges
7. `dot()` - 23 edges
8. `paintParkInfo()` - 23 edges
9. `paint()` - 23 edges
10. `Rule 2 — Nothing it does may impede driving` - 22 edges

## Surprising Connections (you probably didn't know these)
- `The project banner` --semantically_similar_to--> `The top strip`  [INFERRED] [semantically similar]
  docs/assets/banner.svg → src/index.html
- `The three rules set in monospace on the banner` --semantically_similar_to--> `The three rules, as About renders them`  [INFERRED] [semantically similar]
  docs/assets/banner.svg → src/index.html
- `install_update()` --implements--> `Rule 2 — Nothing it does may impede driving`  [INFERRED]
  src-tauri/src/main.rs → README.md
- `serve()` --implements--> `Failure, quietly and without lying`  [EXTRACTED]
  src-tauri/src/mcp.rs → docs/mcp.md
- `ds_events()` --implements--> `A quiet session is not an unreadable file`  [EXTRACTED]
  src-tauri/src/mcp.rs → docs/mcp.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The three rules** — readme_rule_1_never_controls_the_robot, readme_rule_2_never_impedes_driving, readme_rule_3_never_invents_a_number, readme_catalyst_console [EXTRACTED 1.00]
- **The machinery that refuses to invent a number** — readme_rule_3_never_invents_a_number, readme_dslog_parser_fails_closed, readme_match_clock_fallback_chain, readme_absence_is_not_a_dash, readme_waiting_for_fms_game_data, readme_demo_data [EXTRACTED 1.00]
- **The machinery that keeps the board up** — readme_rule_2_never_impedes_driving, readme_ten_hz_paint_timer, readme_board_survives_bad_storage, readme_settings_stands_down, readme_field_render_cost_control [EXTRACTED 1.00]
- **The absent-is-not-zero distinctions** — docs_mcp_absent_is_not_zero, docs_mcp_alerts_null_not_empty_list, docs_mcp_mode_null_without_control_word, docs_mcp_empty_game_message_is_published, docs_mcp_rtt_null_while_disconnected, docs_mcp_nan_as_string, docs_mcp_quiet_session_versus_unreadable, docs_mcp_field_map_says_where_it_looked [EXTRACTED 1.00]
- **The spec sheet's absence discipline** — docs_robot_identity_missing_not_dashed, docs_robot_identity_library_absent_not_zero, docs_robot_identity_partial_plan_degrades, docs_robot_identity_demo_sheet_incomplete, readme_absence_is_not_a_dash [EXTRACTED 1.00]
- **The Settings panel's non-blocking contract** — docs_settings_nothing_applies, docs_settings_nothing_is_modal, docs_settings_it_stands_down, docs_settings_reset_arms_itself, docs_settings_search_in_place [EXTRACTED 1.00]
- **Rule 2 written into the markup itself** — src_index_settings_has_no_aria_modal, src_index_drop_chip_hidden_by_default, src_index_status_under_the_rows, src_index_paste_by_hand_floor [EXTRACTED 1.00]
- **The three rules restated across every surface** — docs_assets_banner_three_rules_as_the_product, src_index_three_rules_in_about, docs_readme_three_rules_restated, readme_rule_1_never_controls_the_robot, readme_rule_2_never_impedes_driving, readme_rule_3_never_invents_a_number [EXTRACTED 1.00]
- **One drawing rasterised at four sizes** — src_tauri_icons_icon_app_icon, src_tauri_icons_32x32_small_icon, src_tauri_icons_128x128_medium_icon, src_tauri_icons_128x128_2x_retina_icon [EXTRACTED 1.00]

## Communities (87 total, 4 thin omitted)

### Community 0 - "field-collision.mjs"
Cohesion: 0.04
Nodes (51): also, bboxCentre, binCells, broken, ceiling, clearanceMm, cols, cropLoX (+43 more)

### Community 1 - "nt4.rs"
Cohesion: 0.05
Nodes (82): AtomicBool, AtomicI64, AtomicU64, Absent is not zero, The advisory travels with the numbers, alerts returns null, not an empty list, field_map says which paths it searched, JSON-RPC 2.0 over stdio (+74 more)

### Community 2 - "main.rs"
Cohesion: 0.11
Nodes (40): AppHandle, Default, Signed releases, I, Two modes, one binary, AppState, attach_parent_console(), candidate_addresses() (+32 more)

### Community 3 - "robot-cad.mjs"
Cohesion: 0.06
Nodes (104): buildManifest(), BUMPER, baseName(), CLASS_RULES, classifyFace(), classifyPart(), colourTone(), DROP_RULES (+96 more)

### Community 4 - "buildSettings"
Cohesion: 0.12
Nodes (31): Bundled but switched off says exactly that, Nothing applies, Release notes are shown as plain text, never rendered, Searching leaves matches where they live, The Settings panel, section by section, Trail length applies on release, The Settings panel, Settings search leaves matches where they live (+23 more)

### Community 5 - "app.js"
Cohesion: 0.03
Nodes (74): agentUrl(), ago(), aimStickNotice(), aimStickSteady, BAR_STEPS, barOverflows(), batteryShownState, BIT (+66 more)

### Community 6 - "tauri.conf.json"
Cohesion: 0.07
Nodes (26): dmg, https://github.com/TomAs-1226/CatalystConsole/releases/latest/download/latest.json, icons/icon.ico, nsis, app, security, windows, withGlobalTauri (+18 more)

### Community 7 - "paintGarage"
Cohesion: 0.12
Nodes (22): A builder for the facts no API can answer, Copy the spec sheet, The demo sheet is deliberately incomplete, Derived rather than passed in, Bumper diagonal and channels used, The Catalyst group leads the sheet, Gear ratios and mass are the exceptions, The library omits rather than zeroes (+14 more)

### Community 8 - "dslog_tests.rs"
Cohesion: 0.07
Nodes (49): A quiet session is not an unreadable file, Drop, Driver Station logs, The .dslog parser fails closed, classify(), default_log_dir(), DsEvent, DsSamples (+41 more)

### Community 9 - "Hub activation tile"
Cohesion: 0.29
Nodes (8): Alternating shifts 1-4, The hub schedule, Auto, transition and end game need no game data, Six teleop segments, Table 6-2, Hub activation tile, HUB versus TOWER terminology, A robot-published answer always wins, REBUILT teleop shift schedule

### Community 10 - "onFrame"
Cohesion: 0.24
Nodes (13): Demo data is amber, alone among the switches, Demo data, applyFrame(), controlWord(), demoCarried(), demoTick(), onFrame(), recordRun() (+5 more)

### Community 11 - "el"
Cohesion: 0.09
Nodes (36): An import is checked whole before anything is applied, Reset arms itself rather than opening a dialog, The component registry, Layout export and import, applyLayoutText(), buildBoard(), clock(), copyText() (+28 more)

### Community 12 - "scripts"
Cohesion: 0.06
Nodes (33): @fontsource-variable/figtree, @gltf-transform/core, @gltf-transform/extensions, meshoptimizer, description, devDependencies, @fontsource-variable/figtree, @gltf-transform/core (+25 more)

### Community 13 - "definitions"
Cohesion: 0.12
Nodes (16): anyOf, description, definitions, Application, Number, PermissionEntry, Target, Value (+8 more)

### Community 14 - "definitions"
Cohesion: 0.12
Nodes (16): anyOf, description, definitions, Application, Number, PermissionEntry, Target, Value (+8 more)

### Community 15 - "setCamera"
Cohesion: 0.18
Nodes (17): One camera, two surfaces, one function, Storage is read one key at a time and every key is checked, The chase camera swings around occluding field elements, Auto chooser, Settings storage is validated key by key, applyFieldCamera(), CAMERAS, clamp() (+9 more)

### Community 16 - "update"
Cohesion: 0.06
Nodes (49): A count and a list answer different questions, The plan is not painted in the alliance colour, The Devices section, The power board is drawn only from a published channel count, activeView(), agoText(), alliance(), arcPath() (+41 more)

### Community 17 - "drivers.js"
Cohesion: 0.07
Nodes (65): The tunables manifest, applyRobotSettings(), commitRobotSetting(), controlBindings(), declaredTunables(), driversSignature(), has(), liveTunable() (+57 more)

### Community 18 - "hidePark"
Cohesion: 0.18
Nodes (19): fieldHandover(), fieldTileNow(), groundNow(), hidePark(), layout, loadParkScene(), moveTile(), onShow() (+11 more)

### Community 19 - "Rule 2 — Nothing it does may impede driving"
Cohesion: 0.11
Nodes (24): The three rules set in monospace on the banner, The quiet update check, Documentation index, The three rules, restated in the docs index, About lays the three rules across on a wide window, Alert hold, Nothing is modal, Every binding is a single unmodified key (+16 more)

### Community 20 - "paintLinkHistory"
Cohesion: 0.20
Nodes (11): Frames counts real NetworkTables frames only, clockOfDay(), linkDrops(), linkLog, linkSource(), linkText(), observeLink(), paintLinkHistory() (+3 more)

### Community 21 - "properties"
Cohesion: 0.15
Nodes (13): properties, Identifier, description, oneOf, type, default, description, type (+5 more)

### Community 22 - "properties"
Cohesion: 0.15
Nodes (13): properties, Identifier, description, oneOf, type, default, description, type (+5 more)

### Community 23 - "Catalyst Console"
Cohesion: 0.15
Nodes (15): The console's own palette, The project banner, The board, suggested rather than drawn, Bundled with the Catalyst desktop app, Installing Catalyst Console, The widget catalogue, Alert group topics, Catalyst Console (+7 more)

### Community 24 - "permissions"
Cohesion: 0.17
Nodes (12): $ref, array, null, description, items, type, uniqueItems, description (+4 more)

### Community 25 - "permissions"
Cohesion: 0.17
Nodes (12): $ref, array, null, description, items, type, uniqueItems, description (+4 more)

### Community 26 - "createField"
Cohesion: 0.14
Nodes (13): The optional field bakes, The baked field model, Field material re-grounding, The procedural field outline, root, scratch, vendor, bakedAssets (+5 more)

### Community 27 - "demo-match.js"
Cohesion: 0.05
Nodes (36): AIM, AIM_STATES, BUMP_X, DEPLOY_POSE_NAMES, DEPLOY_POSES, DEPOT, FEED_HOOD, FEED_LOWER (+28 more)

### Community 28 - "webviews"
Cohesion: 0.22
Nodes (9): type, webviews, windows, description, items, type, description, items (+1 more)

### Community 29 - "webviews"
Cohesion: 0.20
Nodes (10): type, webviews, windows, items, description, items, type, description (+2 more)

### Community 30 - "Rule 1 — It never controls the robot"
Cohesion: 0.19
Nodes (15): The standalone installer, Diagnosis has never needed control, There is no drive tool, and there will not be one, Two NetworkTables clients are ordinary, NetworkTables, NI Driver Station, One console at a time, Rule 1 — It never controls the robot (+7 more)

### Community 31 - "worldTriangles"
Cohesion: 0.31
Nodes (9): apply(), boundsOf(), identity(), instanceCount(), instanceMatrix(), isLooseGamePiece(), multiply(), placementPoints() (+1 more)

### Community 32 - "CapabilityRemote"
Cohesion: 0.20
Nodes (10): description, properties, required, type, CapabilityRemote, urls, urls, description (+2 more)

### Community 33 - "CapabilityRemote"
Cohesion: 0.22
Nodes (9): description, properties, required, type, CapabilityRemote, urls, urls, description (+1 more)

### Community 34 - "standDownOverlaysOnEnable"
Cohesion: 0.43
Nodes (8): It stands down, Settings stands down when the robot goes live, closeOverlays(), isLive(), MODALS, overlayOpen(), settingsOpen(), standDownOverlaysOnEnable()

### Community 35 - "paint"
Cohesion: 0.14
Nodes (20): Opens on applies at launch only, BOOT, buildCanProbes(), canShapeOf(), paint(), paintCan(), paintTopics(), setFlag() (+12 more)

### Community 36 - "vendor.mjs"
Cohesion: 0.38
Nodes (6): Building from source, Strict CSP and vendored three.js, files, out, root, The import map points three at the vendored copy

### Community 37 - "park3d.js"
Cohesion: 0.08
Nodes (34): clampElevation(), closest(), coastAngle(), createPark(), cubicBezier(), dampVelocity(), describeShot(), direction() (+26 more)

### Community 38 - "Capability"
Cohesion: 0.33
Nodes (6): description, required, type, Capability, identifier, permissions

### Community 39 - "Capability"
Cohesion: 0.33
Nodes (6): description, required, type, Capability, identifier, permissions

### Community 40 - "desktop-schema.json"
Cohesion: 0.40
Nodes (4): anyOf, description, $schema, title

### Community 41 - "windows-schema.json"
Cohesion: 0.40
Nodes (4): anyOf, description, $schema, title

### Community 42 - "Rule 3 — It never invents a number"
Cohesion: 0.19
Nodes (13): /FMSInfo carries no match clock, Game data is empty until after auto, Published-and-empty is not absent, Failure, quietly and without lying, Partial figures give a partial drawing, /FMSInfo topics, The /FMSInfo write guard, /FMSInfo/GameSpecificMessage (+5 more)

### Community 43 - "serve.mjs"
Cohesion: 0.50
Nodes (3): port, root, TYPES

### Community 44 - "description"
Cohesion: 0.50
Nodes (4): default, description, type, description

### Community 45 - "description"
Cohesion: 0.50
Nodes (4): default, description, type, description

### Community 46 - "isWall"
Cohesion: 0.67
Nodes (3): floodInterior(), isWall(), seedCell()

### Community 49 - "mechanisms.js"
Cohesion: 0.10
Nodes (27): trackMechanisms(), ballAt(), createAimDebounce(), FEED_RATE, fitKeep(), hasMechanisms(), INTAKE_LOAD_AMPS, isEjecting() (+19 more)

### Community 50 - "runs.js"
Cohesion: 0.07
Nodes (23): AIM_CODE, AIM_ERROR, AIM_FIELDS, AIM_NAMES, AIM_STATE, AIM_TARGET, BATTERY_KEYS, COLUMNS (+15 more)

### Community 51 - "escapeHtml"
Cohesion: 0.15
Nodes (29): buildCanGroups(), cameraStateWords(), canBusHtml(), coreNum(), coreRows(), duration(), escapeHtml(), fraction() (+21 more)

### Community 52 - "can-model.js"
Cohesion: 0.14
Nodes (25): barWidth(), busIndex(), busKind(), BUSY_DEVICE_COUNT, contentionWarnings(), controllerGroup(), CONTROLLERS, ERROR_PASSIVE (+17 more)

### Community 53 - "devices.js"
Cohesion: 0.13
Nodes (21): cameraTables(), clampToField(), deviceSummary(), drivePath(), engagedAutopilot(), limelightFix(), notices(), parseBool() (+13 more)

### Community 54 - "demo-match.test.js"
Cohesion: 0.09
Nodes (20): HOPPER, RED_HUB, ROBOT, scoreHoodDegAt, scoreRpmAt, scoreTimeOfFlightAt, START_POSE, DEPOT (+12 more)

### Community 55 - "field3d.js"
Cohesion: 0.08
Nodes (19): BLUE, BOUNCE, CARPET, CHASE_EYE, CHASE_LOOK, FILL_LIGHT, FLOOR, LINE (+11 more)

### Community 56 - "driver3d.js"
Cohesion: 0.15
Nodes (21): ARRIVED_S, buildMannequin(), clamp01(), createDriver(), createDriverStage(), createModelDriver(), DRIVER_HEIGHT_M, driverPose() (+13 more)

### Community 57 - "robot3d.js"
Cohesion: 0.17
Nodes (19): addBumpers(), arcPlate(), axle(), BATTERY, buildRobot(), BUMPER_FADE_MS, bumperNumber(), createRobotModel() (+11 more)

### Community 58 - "robot-cad.js"
Cohesion: 0.25
Nodes (15): buildCadRobot(), cadSpec(), clamp(), hoodTurn(), intakeMouth(), intakeSlide(), moduleStates(), optimizeModule() (+7 more)

### Community 59 - "device-cad.mjs"
Cohesion: 0.18
Nodes (15): bake(), bakeFromImage(), DEVICES, FBX_FOOTER, FBX_MAGIC, fbxInImage(), fbxLength(), findImage() (+7 more)

### Community 60 - "aim-target.test.js"
Cohesion: 0.21
Nodes (14): aimCaption(), aimedAt(), enterSquare(), faceSpan(), hub(), hubContaining(), HUBS, nearestTag() (+6 more)

### Community 61 - "runs.test.js"
Cohesion: 0.18
Nodes (16): MATCH_S, noise(), createRunRecorder(), frameState(), RUNS_KEPT, SAMPLE_CAPACITY, SPEED_BANDS, aimAtSpeeds() (+8 more)

### Community 62 - "Changelog"
Cohesion: 0.12
Nodes (15): [0.2.0] — 2026-08-05 — Impacts and swerve tiles., [0.3.0] — 2026-08-06 — In-place updates., [0.4.0] — 2026-08-06 — About page, layout portability, shortcuts, connection history, a read-only diagnostics MCP., [0.5.0] — 2026-08-06 — Settings, and the robot's own spec sheet., [0.5.1] — 2026-08-06 — The garage, properly., [0.6.0] — 2026-08-06 — What the robot is made to do., [0.7.0] — 2026-08-06 — Search, release notes, and documentation that is true., [0.8.0] — 2026-08-06 — Less text, more robot. (+7 more)

### Community 63 - "wpilog_tests.rs"
Cohesion: 0.27
Nodes (11): a_file_that_is_not_a_wpilog_is_refused_rather_than_decoded(), a_real_driver_station_session_reads(), a_session_yields_its_battery_trace(), a_truncated_record_stops_the_read_instead_of_running_off_the_end(), every_field_width_decodes_the_same_way(), LogBuilder, round_trip_time_arrives_in_milliseconds(), PathBuf (+3 more)

### Community 64 - "device3d.js"
Cohesion: 0.21
Nodes (11): paintCameraPart(), paintCoreHero(), partSize(), CLAY, createDeviceStage(), deviceById(), loadDevices(), studioEnvironment() (+3 more)

### Community 65 - "hub.js"
Cohesion: 0.27
Nodes (12): matchClock(), redHubActive(), redHubActive(), activeIn(), AUTO_S, clamp01(), hubPlan(), inactiveFirst() (+4 more)

### Community 66 - "calibration.js"
Cohesion: 0.29
Nodes (7): calibrationNames(), calibrationNotice(), calibrationNotices(), displayName(), finite(), runningText(), SUSPECT_PERCENT

### Community 67 - "paintRunList"
Cohesion: 0.31
Nodes (10): paintRunList(), paintRunMain(), paintRuns(), runBefore(), runTracesHtml(), describeChanges(), modeLabel(), runWhen() (+2 more)

### Community 68 - "hopper3d.js"
Cohesion: 0.31
Nodes (8): createHopperBalls(), pairPlaces(), slotPosition(), slotPresence(), smooth(), DEPLOYED, STOWED, FEED_TRAVEL_S

### Community 69 - "finite"
Cohesion: 0.40
Nodes (10): atSpeed(), finite(), fixed(), metres(), percent(), readPose(), runCard(), runClock() (+2 more)

### Community 70 - "robot-cad-preview.mjs"
Cohesion: 0.36
Nodes (8): EDGE_CANDIDATES, main(), renderViews(), root, serve(), sleep(), standardViews(), TYPES

### Community 71 - "demoMatch"
Cohesion: 0.25
Nodes (9): aimSolution(), chase(), clamp(), demoMatch(), demoMatchSummary(), hermite(), pathAhead(), record() (+1 more)

### Community 72 - "motion.js"
Cohesion: 0.22
Nodes (3): GESTURE, ROLE, stateLayer()

### Community 73 - "AGENTS.md: Catalyst Console"
Cohesion: 0.25
Nodes (7): AGENTS.md: Catalyst Console, Commands, Docs, Git and files, If you are a fallback model, The three rules, What this is

### Community 74 - "CAN buses"
Cohesion: 0.25
Nodes (7): Absent is not zero, CAN buses, Error counters, The pair figure, What it deliberately does not do, What the console works out, and what the robot said, Where the numbers come from

### Community 75 - "check-identity.mjs"
Cohesion: 0.29
Nodes (6): args, FILES, given, root, source, write

### Community 76 - "driver-cad.mjs"
Cohesion: 0.38
Nodes (6): contents(), DEFAULT_SOURCE, log(), main(), root, WANTED

### Community 77 - "reviveRun"
Cohesion: 0.43
Nodes (7): ENDINGS, fields(), loadRuns(), numberOrNull(), reviveAim(), reviveRun(), textOrNull()

### Community 78 - "core-format.js"
Cohesion: 0.60
Nodes (4): bytes(), level(), preEolState(), wearText()

### Community 79 - "overdrive.js"
Cohesion: 0.60
Nodes (4): createOverdriveDebounce(), OVERDRIVE_COOLDOWN_MS, OVERDRIVE_ENGAGE_MS, OVERDRIVE_WARP_MS

### Community 81 - "The team number lives in the backend config"
Cohesion: 0.50
Nodes (5): The diagnostics MCP server, Candidate address cycling, The read-only diagnostics MCP server, The team number lives in the backend config, candidateAddresses()

### Community 82 - "drawRunTraces"
Cohesion: 0.40
Nodes (5): drawRunTraces(), drawTrace(), tokenAlpha(), traceSegments(), valueRange()

### Community 83 - "runFileName"
Cohesion: 0.50
Nodes (4): exportRun(), selectedRun(), runCsv(), runFileName()

## Ambiguous Edges - Review These
- `Rule 1 — It never controls the robot` → `The steering wheel motif`  [AMBIGUOUS]
  src-tauri/icons/icon.png · relation: conceptually_related_to
- `One console at a time` → `The 32px application icon`  [AMBIGUOUS]
  src-tauri/icons/32x32.png · relation: conceptually_related_to

## Knowledge Gaps
- **424 isolated node(s):** `name`, `version`, `private`, `description`, `type` (+419 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Rule 1 — It never controls the robot` and `The steering wheel motif`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `One console at a time` and `The 32px application icon`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `update()` connect `update` to `hub.js`, `robot-cad.mjs`, `paint`, `app.js`, `Rule 3 — It never invents a number`, `el`, `core-format.js`, `overdrive.js`, `drivers.js`, `hidePark`, `escapeHtml`, `can-model.js`, `devices.js`, `mechanisms.js`, `aim-target.test.js`?**
  _High betweenness centrality (0.131) - this node is a cross-community bridge._
- **Why does `sub()` connect `robot-cad.mjs` to `update`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `scale()` connect `robot-cad.mjs` to `update`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `update()` (e.g. with `scale()` and `sub()`) actually correct?**
  _`update()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `escapeHtml()` (e.g. with `Release notes are shown as plain text, never rendered` and `paintAgentCameras()`) actually correct?**
  _`escapeHtml()` has 2 INFERRED edges - model-reasoned connections that need verification._