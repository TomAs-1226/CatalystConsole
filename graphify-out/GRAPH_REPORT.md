# Graph Report - CatalystConsole  (2026-10-09)

## Corpus Check
- 106 files · ~293,195 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: .css 2, (none) 1, .ico 1)

## Summary
- 1724 nodes · 3891 edges · 87 communities (79 shown, 8 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 62 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d1a31d95`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- field-collision.mjs
- mcp.rs
- main.rs
- robot-cad.mjs
- buildSettings
- app.js
- tauri.conf.json
- The garage
- dslog.rs
- The contract with the robot
- onFrame
- el
- scripts
- nt4.rs
- createRunRecorder
- Nt4Client
- paintParkInfo
- drivers.js
- paint
- paintLinkHistory
- README.md
- dslog_tests.rs
- The Tauri icon set
- step
- package.json
- createField
- demo-match.js
- park-state.test.js
- NtValue
- driver-station.js
- worldTriangles
- Settings
- Installing Catalyst Console
- The diagnostics MCP server
- placeCamera
- ref_node_fs
- park3d.js
- SetValue
- docs/README.md
- Widgets
- devDependencies
- The hub schedule
- AppState
- paintNotices
- Components
- isWall
- rasterEdge
- catalyst-console
- mechanisms.js
- runs.js
- escapeHtml
- can-model.js
- devices.js
- demo-match.test.js
- field3d.js
- driver3d.js
- robot3d.js
- device-cad.mjs
- aim-target.test.js
- runs.test.js
- Changelog
- wpilog_tests.rs
- hub.js
- calibration.js
- paintRunList
- finite
- robot-cad-preview.mjs
- demoMatch
- motion.js
- AGENTS.md: Catalyst Console
- CAN buses
- check-identity.mjs
- ref_node_url
- core-format.js
- overdrive.js
- version-files.test.js
- Mode
- drawRunTraces
- update
- release.mjs
- paintDrivers
- The three rules set in monospace on the banner
- setText
- createMotionFilter
- board-format.js

## God Nodes (most connected - your core abstractions)
1. `update()` - 65 edges
2. `main()` - 48 edges
3. `createField()` - 45 edges
4. `paintParkInfo()` - 32 edges
5. `escapeHtml()` - 30 edges
6. `buildSettings()` - 28 edges
7. `dot()` - 23 edges
8. `NtValue` - 22 edges
9. `finite()` - 22 edges
10. `paint()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `The project banner` --semantically_similar_to--> `The top strip`  [INFERRED] [semantically similar]
  docs/assets/banner.svg → src/index.html
- `The three rules set in monospace on the banner` --semantically_similar_to--> `The three rules, as About renders them`  [INFERRED] [semantically similar]
  docs/assets/banner.svg → src/index.html
- `Writing your own` --references--> `update()`  [INFERRED]
  docs/widgets.md → src/app.js
- `The garage card markup` --implements--> `The garage`  [EXTRACTED]
  src/index.html → docs/robot-identity.md
- `The Tauri icon set` --shares_data_with--> `The console's own palette`  [INFERRED]
  src-tauri/icons/icon.png → docs/assets/banner.svg

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Rule 2 written into the markup itself** — src_index_settings_has_no_aria_modal, src_index_drop_chip_hidden_by_default, src_index_status_under_the_rows, src_index_paste_by_hand_floor [EXTRACTED 1.00]
- **One drawing rasterised at four sizes** — src_tauri_icons_icon_app_icon, src_tauri_icons_32x32_small_icon, src_tauri_icons_128x128_medium_icon, src_tauri_icons_128x128_2x_retina_icon [EXTRACTED 1.00]

## Communities (87 total, 8 thin omitted)

### Community 0 - "field-collision.mjs"
Cohesion: 0.04
Nodes (51): also, bboxCentre, binCells, broken, ceiling, clearanceMm, cols, cropLoX (+43 more)

### Community 1 - "mcp.rs"
Cohesion: 0.12
Nodes (18): content(), DEFAULT_ALERT_GROUP, DEFAULT_PROTOCOL_VERSION, ds_events(), ds_sessions(), error(), field_map(), field_map_candidates() (+10 more)

### Community 2 - "main.rs"
Cohesion: 0.13
Nodes (19): attach_parent_console(), candidate_addresses(), check_update(), DEFAULT_TEAM, HELP, IDENTIFIER, install_update(), load_settings() (+11 more)

### Community 3 - "robot-cad.mjs"
Cohesion: 0.06
Nodes (101): buildManifest(), BUMPER, baseName(), CLASS_RULES, classifyFace(), classifyPart(), colourTone(), DROP_RULES (+93 more)

### Community 4 - "buildSettings"
Cohesion: 0.08
Nodes (35): ABOUT_LINKS, applyFieldCamera(), applySearch(), applyTeam(), applyUpdateInfo(), assetLabel(), buildSettings(), candidateAddresses() (+27 more)

### Community 5 - "app.js"
Cohesion: 0.03
Nodes (86): agentUrl(), aimStickSteady, assistSeen, bakedAssets, BAR_STEPS, barOverflows(), batteryShownState, BIT (+78 more)

### Community 6 - "tauri.conf.json"
Cohesion: 0.08
Nodes (23): app, security, windows, withGlobalTauri, build, beforeBuildCommand, frontendDist, bundle (+15 more)

### Community 7 - "The garage"
Cohesion: 0.22
Nodes (9): Copying it out, Seeing it without a robot, The garage, The plan, Units, What a team has to do, What appears, What the robot is made to do (+1 more)

### Community 8 - "dslog.rs"
Cohesion: 0.10
Nodes (22): classify(), DsEvent, DsSamples, DsSession, LABVIEW_EPOCH_OFFSET, labview_seconds(), list_sessions(), read_events() (+14 more)

### Community 9 - "The contract with the robot"
Cohesion: 0.20
Nodes (10): Alerts, Auto chooser, Health, Live tuning, Physics Core, Shot and pose status (team 5805's Numbers), The contract with the robot, The robot's own account of itself (+2 more)

### Community 10 - "onFrame"
Cohesion: 0.21
Nodes (10): applyFrame(), controlWord(), demoCarried(), demoTick(), KEYS, onFrame(), recordRun(), refreshTopicList() (+2 more)

### Community 11 - "el"
Cohesion: 0.10
Nodes (29): applyLayoutText(), buildBoard(), clock(), copyText(), defaults(), dispose(), downloadText(), el() (+21 more)

### Community 12 - "scripts"
Cohesion: 0.12
Nodes (16): scripts, build, check-identity, dev, device-cad, driver-cad, field-cad, field-collision (+8 more)

### Community 13 - "nt4.rs"
Cohesion: 0.13
Nodes (11): a_pose_array_decodes_to_triples(), a_single_pose_decodes_to_one_triple(), control_word(), decode_struct(), decode_value(), FLUSH_HZ, game_piece_poses_decode_to_sevens(), Nums (+3 more)

### Community 14 - "createRunRecorder"
Cohesion: 0.14
Nodes (24): cameraKeys(), createRunRecorder(), closeAttempt(), credit(), finish(), observe(), ringPush(), ringSpeed() (+16 more)

### Community 15 - "Nt4Client"
Cohesion: 0.16
Nodes (11): an_empty_pose_array_is_an_empty_list(), chooser_write_reaches_server_and_active_changes_only_on_acknowledgement(), handle_binary(), handle_control(), now_micros(), Nt4Client, NtStatus, run_session() (+3 more)

### Community 16 - "paintParkInfo"
Cohesion: 0.13
Nodes (19): agoText(), alliance(), batteryReadiness(), batteryShown(), batteryVolts(), clamp01(), latestSystemCheck(), matchTime() (+11 more)

### Community 17 - "drivers.js"
Cohesion: 0.09
Nodes (38): rememberBoard(), tunables(), wireDrivers(), SYSTEM_CHECK, activeDriver(), addDriver(), capture(), captureRobot() (+30 more)

### Community 18 - "paint"
Cohesion: 0.10
Nodes (31): activeView(), cadFits(), fieldHandover(), fieldTileNow(), garageShow(), groundNow(), hidePark(), layout (+23 more)

### Community 20 - "paintLinkHistory"
Cohesion: 0.25
Nodes (8): clockOfDay(), linkDrops(), linkSource(), linkText(), observeLink(), paintLinkHistory(), pushLink(), tickLinkHistory()

### Community 21 - "README.md"
Cohesion: 0.11
Nodes (18): Autonomy 2.0 tile (1.4.0), Building it from source, CAN buses, Controller keys, and a 2027 demo robot (1.4.2), Diagnostics for an agent, Documentation, Driver Station logs, Finding the robot (+10 more)

### Community 22 - "dslog_tests.rs"
Cohesion: 0.27
Nodes (12): a_header_with_no_records_reports_nothing_decoded(), a_short_or_missing_file_says_so_instead_of_panicking(), a_truncated_trailing_record_is_dropped_not_decoded_from_padding(), an_unknown_version_refuses_rather_than_guessing(), battery_decodes_as_a_fixed_point_pair(), both_known_versions_parse(), dslog(), every_record_is_decoded() (+4 more)

### Community 23 - "The Tauri icon set"
Cohesion: 0.16
Nodes (14): The console's own palette, The project banner, app, VIEWS, The app shell, The dock, The four views, The top strip (+6 more)

### Community 24 - "step"
Cohesion: 0.15
Nodes (17): backExtentX(), chase(), clamp(), demoMatchSummary(), feedHoodDegAt, feedRpmAt, inBox(), inRange() (+9 more)

### Community 25 - "package.json"
Cohesion: 0.14
Nodes (12): description, name, private, type, version, @fontsource-variable/figtree, @gltf-transform/core, @gltf-transform/extensions (+4 more)

### Community 26 - "createField"
Cohesion: 0.11
Nodes (28): createField(), blockedAt(), draw(), fadeTrail(), launchBall(), lob(), motionAhead(), placeFog() (+20 more)

### Community 27 - "demo-match.js"
Cohesion: 0.06
Nodes (31): AIM, AIM_STATES, BUMP_X, DEPLOY_POSE_NAMES, DEPLOY_POSES, DEPOT, FEED_HOOD, FEED_LOWER (+23 more)

### Community 28 - "park-state.test.js"
Cohesion: 0.19
Nodes (7): chooserSelection(), parkIdentity(), selectedAutoStart(), shotAtFieldPose(), team(), nums(), startData()

### Community 29 - "NtValue"
Cohesion: 0.19
Nodes (13): bool_of(), control_word_of(), num_of(), str_of(), type_name(), NtValue, Bool, Bools (+5 more)

### Community 30 - "driver-station.js"
Cohesion: 0.32
Nodes (10): controlWordNumber(), DRIVER_STATION, FMS_INFO, hasUtilityControlWord(), nativeOrLegacy(), nativeValue(), readAlliance(), readControlWord() (+2 more)

### Community 31 - "worldTriangles"
Cohesion: 0.31
Nodes (9): apply(), boundsOf(), identity(), instanceCount(), instanceMatrix(), isLooseGamePiece(), multiply(), placementPoints() (+1 more)

### Community 32 - "Settings"
Cohesion: 0.17
Nodes (12): About, Cameras, Dashboard, Data, Devices, Field view, How it behaves, Robot (+4 more)

### Community 33 - "Installing Catalyst Console"
Cohesion: 0.22
Nodes (8): 1. With the Catalyst desktop app (easiest), 2. Standalone installer, 3. From source, First run, Installing Catalyst Console, Is it legal at competition?, The field model, optionally, Updating

### Community 34 - "The diagnostics MCP server"
Cohesion: 0.22
Nodes (8): A worked call, Absent is not zero, Failure, Pointing an agent at it, The diagnostics MCP server, The tools, There is no drive tool, and there will not be one, What it speaks

### Community 35 - "placeCamera"
Cohesion: 0.31
Nodes (9): angleTo(), placeCamera(), relFromCamera(), stepRobot(), topHeight(), wantedRel(), polar(), spring() (+1 more)

### Community 36 - "ref_node_fs"
Cohesion: 0.18
Nodes (6): port, root, TYPES, files, out, root

### Community 37 - "park3d.js"
Cohesion: 0.05
Nodes (73): paintCameraPart(), paintCoreHero(), partSize(), CLAY, createDeviceStage(), frame(), resize(), showModel() (+65 more)

### Community 38 - "SetValue"
Cohesion: 0.22
Nodes (4): SetRequest, SetValue, Bool, Num

### Community 40 - "Widgets"
Cohesion: 0.25
Nodes (8): Field, Health, Match, Pit, Telemetry, The gauge, Widgets, Writing your own

### Community 41 - "devDependencies"
Cohesion: 0.29
Nodes (7): devDependencies, @fontsource-variable/figtree, @gltf-transform/core, @gltf-transform/extensions, meshoptimizer, @tauri-apps/cli, three

### Community 42 - "The hub schedule"
Cohesion: 0.33
Nodes (6): Overriding it, The countdown, The hub schedule, The match clock, The segments, Where the console gets it

### Community 43 - "AppState"
Cohesion: 0.40
Nodes (4): AppState, Frame, nt_frame(), nt_set()

### Community 44 - "paintNotices"
Cohesion: 0.40
Nodes (5): assistNotice(), paintAlertIndicator(), paintNotices(), winnerUnknownHeld(), numbersNotices()

### Community 45 - "Components"
Cohesion: 0.50
Nodes (4): Components, Hub activation, The field view, The gauge

### Community 46 - "isWall"
Cohesion: 0.67
Nodes (3): floodInterior(), isWall(), seedCell()

### Community 49 - "mechanisms.js"
Cohesion: 0.10
Nodes (27): aimStickNotice(), trackMechanisms(), ballAt(), createAimDebounce(), FEED_RATE, fitKeep(), hasMechanisms(), INTAKE_LOAD_AMPS (+19 more)

### Community 50 - "runs.js"
Cohesion: 0.10
Nodes (27): AIM_CODE, AIM_ERROR, AIM_FIELDS, AIM_NAMES, AIM_STATE, AIM_TARGET, BATTERY_KEYS, COLUMNS (+19 more)

### Community 51 - "escapeHtml"
Cohesion: 0.10
Nodes (42): ago(), arr(), buildCanGroups(), buildCanProbes(), cameraStateWords(), canBusHtml(), canShapeOf(), coreNum() (+34 more)

### Community 52 - "can-model.js"
Cohesion: 0.14
Nodes (25): barWidth(), busIndex(), busKind(), BUSY_DEVICE_COUNT, contentionWarnings(), controllerGroup(), CONTROLLERS, ERROR_PASSIVE (+17 more)

### Community 53 - "devices.js"
Cohesion: 0.11
Nodes (24): fraction(), paintDeviceStrip(), cameraTables(), clampToField(), countState(), deviceSummary(), drivePath(), engagedAutopilot() (+16 more)

### Community 54 - "demo-match.test.js"
Cohesion: 0.09
Nodes (18): HOPPER, RED_HUB, ROBOT, scoreTimeOfFlightAt, START_POSE, DEPOT, estimate(), FIELD (+10 more)

### Community 55 - "field3d.js"
Cohesion: 0.08
Nodes (24): BLUE, BOUNCE, CARPET, carve(), CHASE_EYE, CHASE_LOOK, loadFieldModel(), FILL_LIGHT (+16 more)

### Community 56 - "driver3d.js"
Cohesion: 0.13
Nodes (24): applyPose(), ARRIVED_S, buildMannequin(), clamp01(), createDriver(), createDriverStage(), resize(), tick() (+16 more)

### Community 57 - "robot3d.js"
Cohesion: 0.08
Nodes (55): keep(), loadDriverModel(), createHopperBalls(), drawn(), fedAt(), pickupAt(), pickupStart(), setCount() (+47 more)

### Community 59 - "device-cad.mjs"
Cohesion: 0.15
Nodes (16): three, bake(), bakeFromImage(), DEVICES, FBX_FOOTER, FBX_MAGIC, fbxInImage(), fbxLength() (+8 more)

### Community 60 - "aim-target.test.js"
Cohesion: 0.18
Nodes (14): aimCaption(), aimedAt(), enterSquare(), faceSpan(), hubContaining(), HUBS, nearestTag(), standoffPose() (+6 more)

### Community 61 - "runs.test.js"
Cohesion: 0.15
Nodes (18): exportRun(), selectedRun(), MATCH_S, noise(), runCsv(), runFileName(), RUNS_KEPT, SAMPLE_CAPACITY (+10 more)

### Community 62 - "Changelog"
Cohesion: 0.10
Nodes (19): [0.2.0] — 2026-08-05 — Impacts and swerve tiles., [0.3.0] — 2026-08-06 — In-place updates., [0.4.0] — 2026-08-06 — About page, layout portability, shortcuts, connection history, a read-only diagnostics MCP., [0.5.0] — 2026-08-06 — Settings, and the robot's own spec sheet., [0.5.1] — 2026-08-06 — The garage, properly., [0.6.0] — 2026-08-06 — What the robot is made to do., [0.7.0] — 2026-08-06 — Search, release notes, and documentation that is true., [0.8.0] — 2026-08-06 — Less text, more robot. (+11 more)

### Community 63 - "wpilog_tests.rs"
Cohesion: 0.33
Nodes (8): a_file_that_is_not_a_wpilog_is_refused_rather_than_decoded(), a_real_driver_station_session_reads(), a_session_yields_its_battery_trace(), a_truncated_record_stops_the_read_instead_of_running_off_the_end(), every_field_width_decodes_the_same_way(), LogBuilder, round_trip_time_arrives_in_milliseconds(), sessions_are_listed_newest_first_and_only_wpilogs()

### Community 65 - "hub.js"
Cohesion: 0.22
Nodes (14): gameMessage(), paintMatchCue(), matchClock(), redHubActive(), redHubActive(), activeIn(), AUTO_S, clamp01() (+6 more)

### Community 66 - "calibration.js"
Cohesion: 0.29
Nodes (7): calibrationNames(), calibrationNotice(), calibrationNotices(), displayName(), finite(), runningText(), SUSPECT_PERCENT

### Community 67 - "paintRunList"
Cohesion: 0.23
Nodes (13): paintPart(), paintRunList(), paintRunMain(), paintRuns(), runBefore(), runTracesHtml(), showPart(), wireParts() (+5 more)

### Community 69 - "finite"
Cohesion: 0.47
Nodes (9): atSpeed(), finite(), fixed(), metres(), percent(), runCard(), runClock(), runFigures() (+1 more)

### Community 70 - "robot-cad-preview.mjs"
Cohesion: 0.18
Nodes (11): root, scratch, vendor, EDGE_CANDIDATES, main(), renderViews(), root, serve() (+3 more)

### Community 71 - "demoMatch"
Cohesion: 0.50
Nodes (5): aimSolution(), demoMatch(), hermite(), pathAhead(), wrap()

### Community 72 - "motion.js"
Cohesion: 0.22
Nodes (3): GESTURE, ROLE, stateLayer()

### Community 73 - "AGENTS.md: Catalyst Console"
Cohesion: 0.25
Nodes (7): AGENTS.md: Catalyst Console, Commands, Docs, Git and files, If you are a fallback model, The three rules, What this is

### Community 74 - "CAN buses"
Cohesion: 0.29
Nodes (7): Absent is not zero, CAN buses, Error counters, The pair figure, What it deliberately does not do, What the console works out, and what the robot said, Where the numbers come from

### Community 75 - "check-identity.mjs"
Cohesion: 0.25
Nodes (6): args, FILES, given, root, source, write

### Community 76 - "ref_node_url"
Cohesion: 0.32
Nodes (6): contents(), DEFAULT_SOURCE, log(), main(), root, WANTED

### Community 78 - "core-format.js"
Cohesion: 0.60
Nodes (4): bytes(), level(), preEolState(), wearText()

### Community 79 - "overdrive.js"
Cohesion: 0.48
Nodes (4): createOverdriveDebounce(), OVERDRIVE_COOLDOWN_MS, OVERDRIVE_ENGAGE_MS, OVERDRIVE_WARP_MS

### Community 81 - "Mode"
Cohesion: 0.33
Nodes (5): Mode, Gui, Help, Mcp, parse_args()

### Community 82 - "drawRunTraces"
Cohesion: 0.40
Nodes (5): drawRunTraces(), drawTrace(), tokenAlpha(), traceSegments(), valueRange()

### Community 84 - "update"
Cohesion: 0.15
Nodes (35): commonPrefix(), history(), motorRowsFromNt(), update(), accelLimitText(), ASSIST_WORDS, assistLevelText(), assistText() (+27 more)

### Community 87 - "release.mjs"
Cohesion: 0.11
Nodes (18): bare, built, dirty(), dryRun, env, files, head, installer (+10 more)

### Community 88 - "paintDrivers"
Cohesion: 0.17
Nodes (25): applyRobotSettings(), commitRobotSetting(), controlBindings(), declaredTunables(), distinctLabels(), driversSignature(), leaf(), liveTunable() (+17 more)

### Community 92 - "setText"
Cohesion: 0.53
Nodes (6): setFlag(), setLevel(), setText(), setWidth(), writeCanBus(), writeCanPair()

### Community 95 - "createMotionFilter"
Cohesion: 0.47
Nodes (3): createMotionFilter(), updateTurn(), turnBetween()

## Knowledge Gaps
- **14 isolated node(s):** `@fontsource-variable/figtree`, `@tauri-apps/cli`, `catalyst-console`, `Gui`, `Mcp` (+9 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 592 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `update()` connect `update` to `board-format.js`, `hub.js`, `app.js`, `Widgets`, `el`, `park-state.test.js`, `setText`, `paintParkInfo`, `mechanisms.js`, `paint`, `escapeHtml`, `overdrive.js`, `devices.js`, `paintDrivers`, `aim-target.test.js`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `update()` (e.g. with `Writing your own` and `poseAge()`) actually correct?**
  _`update()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@fontsource-variable/figtree`, `@tauri-apps/cli`, `catalyst-console` to the rest of the system?**
  _14 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `field-collision.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.03636363636363636 - nodes in this community are weakly interconnected._
- **Why does `Widgets` connect `Widgets` to `docs/README.md`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `createField()` (e.g. with `resize()` and `tick()`) actually correct?**
  _`createField()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `mcp.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.12100840336134454 - nodes in this community are weakly interconnected._