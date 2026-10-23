# Graph Report - CatalystConsole  (2026-10-22)

## Corpus Check
- 119 files · ~297,169 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: .css 2, (none) 1, .ico 1)

## Summary
- 1810 nodes · 4084 edges · 93 communities (86 shown, 7 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 65 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ba4cff65`
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
- finish
- Nt4Client
- paintParkInfo
- drivers.js
- hidePark
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
- createRunRecorder
- worldTriangles
- Settings
- Installing Catalyst Console
- The diagnostics MCP server
- placeCamera
- ref_node_fs
- park3d.js
- devices.js
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
- createSurroundView
- demo-match.test.js
- field3d.js
- driver3d.js
- robot3d.js
- Element
- device-cad.mjs
- aim-target.test.js
- runs.test.js
- Changelog
- camera.rs
- createPark
- hub.js
- calibration.js
- paintRunList
- surround-ui.js
- finite
- robot-cad-preview.mjs
- demoMatch
- motion.js
- AGENTS.md: Catalyst Console
- CAN buses
- check-identity.mjs
- driver-cad.mjs
- hopper3d.js
- core-format.js
- overdrive.js
- device3d.js
- Mode
- drawRunTraces
- buildRobot
- update
- createRobotModel
- release.mjs
- surround-panorama.test.js
- The three rules set in monospace on the banner
- setText
- createMotionFilter
- ref_node_assert

## God Nodes (most connected - your core abstractions)
1. `update()` - 65 edges
2. `main()` - 48 edges
3. `createField()` - 45 edges
4. `paintParkInfo()` - 32 edges
5. `escapeHtml()` - 30 edges
6. `buildSettings()` - 28 edges
7. `paint()` - 25 edges
8. `dot()` - 23 edges
9. `NtValue` - 22 edges
10. `finite()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `The project banner` --semantically_similar_to--> `The top strip`  [INFERRED] [semantically similar]
  docs/assets/banner.svg → src/index.html
- `The three rules set in monospace on the banner` --semantically_similar_to--> `The three rules, as About renders them`  [INFERRED] [semantically similar]
  docs/assets/banner.svg → src/index.html
- `Writing your own` --references--> `update()`  [INFERRED]
  docs/widgets.md → src/app.js
- `Driver cameras` --references--> `alliance()`  [INFERRED]
  docs/settings.md → src/app.js
- `Driver cameras` --references--> `teleop()`  [INFERRED]
  docs/settings.md → src/hub.test.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **One drawing rasterised at four sizes** — src_tauri_icons_icon_app_icon, src_tauri_icons_32x32_small_icon, src_tauri_icons_128x128_medium_icon, src_tauri_icons_128x128_2x_retina_icon [EXTRACTED 1.00]
- **Rule 2 written into the markup itself** — src_index_settings_has_no_aria_modal, src_index_drop_chip_hidden_by_default, src_index_status_under_the_rows, src_index_paste_by_hand_floor [EXTRACTED 1.00]

## Communities (93 total, 7 thin omitted)

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
Nodes (103): meshoptimizer, buildManifest(), BUMPER, baseName(), CLASS_RULES, classifyFace(), classifyPart(), colourTone() (+95 more)

### Community 4 - "buildSettings"
Cohesion: 0.09
Nodes (33): ABOUT_LINKS, applyFieldCamera(), applySearch(), applyTeam(), applyUpdateInfo(), assetLabel(), buildSettings(), candidateAddresses() (+25 more)

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
Cohesion: 0.25
Nodes (7): applyFrame(), demoCarried(), demoTick(), KEYS, onFrame(), refreshTopicList(), setDemo()

### Community 11 - "el"
Cohesion: 0.09
Nodes (31): applyLayoutText(), buildBoard(), clock(), copyText(), defaults(), dispose(), downloadText(), el() (+23 more)

### Community 12 - "scripts"
Cohesion: 0.12
Nodes (16): scripts, build, check-identity, dev, device-cad, driver-cad, field-cad, field-collision (+8 more)

### Community 13 - "nt4.rs"
Cohesion: 0.11
Nodes (12): a_pose_array_decodes_to_triples(), a_single_pose_decodes_to_one_triple(), an_empty_pose_array_is_an_empty_list(), decode_value(), FLUSH_HZ, game_piece_poses_decode_to_sevens(), handle_control(), packed() (+4 more)

### Community 14 - "finish"
Cohesion: 0.40
Nodes (5): closeAttempt(), finish(), trackAttempt(), histogramPercentile(), median()

### Community 15 - "Nt4Client"
Cohesion: 0.12
Nodes (13): TempFile, Frame, chooser_write_reaches_server_and_active_changes_only_on_acknowledgement(), handle_binary(), now_micros(), Nt4Client, NtStatus, run_session() (+5 more)

### Community 16 - "paintParkInfo"
Cohesion: 0.07
Nodes (46): agoText(), alliance(), arr(), batteryReadiness(), batteryShown(), batteryVolts(), cadFits(), clamp01() (+38 more)

### Community 17 - "drivers.js"
Cohesion: 0.07
Nodes (59): applyRobotSettings(), commitRobotSetting(), controlBindings(), declaredTunables(), driversSignature(), liveTunable(), ntSet(), paintControls() (+51 more)

### Community 18 - "hidePark"
Cohesion: 0.15
Nodes (21): activeView(), fieldHandover(), fieldTileNow(), groundNow(), hidePark(), layout, loadParkScene(), moveTile() (+13 more)

### Community 20 - "paintLinkHistory"
Cohesion: 0.25
Nodes (8): clockOfDay(), linkDrops(), linkSource(), linkText(), observeLink(), paintLinkHistory(), pushLink(), tickLinkHistory()

### Community 21 - "README.md"
Cohesion: 0.10
Nodes (19): Autonomy 2.0 tile (1.4.0), Building it from source, CAN buses, Changes in 2.1.1, Controller keys, and a 2027 demo robot (1.4.2), Diagnostics for an agent, Documentation, Driver Station logs (+11 more)

### Community 22 - "dslog_tests.rs"
Cohesion: 0.26
Nodes (11): a_header_with_no_records_reports_nothing_decoded(), a_short_or_missing_file_says_so_instead_of_panicking(), a_truncated_trailing_record_is_dropped_not_decoded_from_padding(), an_unknown_version_refuses_rather_than_guessing(), battery_decodes_as_a_fixed_point_pair(), both_known_versions_parse(), dslog(), every_record_is_decoded() (+3 more)

### Community 23 - "The Tauri icon set"
Cohesion: 0.16
Nodes (14): The console's own palette, The project banner, app, VIEWS, The app shell, The dock, The four views, The top strip (+6 more)

### Community 24 - "step"
Cohesion: 0.15
Nodes (17): backExtentX(), chase(), clamp(), demoMatchSummary(), feedHoodDegAt, feedRpmAt, inBox(), inRange() (+9 more)

### Community 25 - "package.json"
Cohesion: 0.16
Nodes (11): description, name, private, type, version, @fontsource-variable/figtree, @gltf-transform/core, @gltf-transform/extensions (+3 more)

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
Cohesion: 0.15
Nodes (16): bool_of(), control_word_of(), num_of(), str_of(), type_name(), control_word(), decode_struct(), NtValue (+8 more)

### Community 30 - "createRunRecorder"
Cohesion: 0.15
Nodes (22): gameMessage(), controlWordNumber(), DRIVER_STATION, FMS_INFO, hasUtilityControlWord(), nativeOrLegacy(), nativeValue(), readAlliance() (+14 more)

### Community 31 - "worldTriangles"
Cohesion: 0.31
Nodes (9): apply(), boundsOf(), identity(), instanceCount(), instanceMatrix(), isLooseGamePiece(), multiply(), placementPoints() (+1 more)

### Community 32 - "Settings"
Cohesion: 0.15
Nodes (13): About, Cameras, Dashboard, Data, Devices, Driver cameras, Field view, How it behaves (+5 more)

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
Cohesion: 0.12
Nodes (8): source, port, root, TYPES, files, out, root, root

### Community 37 - "park3d.js"
Cohesion: 0.10
Nodes (29): coastAngle(), step(), cubicBezier(), dampVelocity(), describeShot(), ELEVATION_DEFAULT, ELEVATION_MAX, ELEVATION_MIN (+21 more)

### Community 38 - "devices.js"
Cohesion: 0.12
Nodes (23): latestSystemCheck(), cameraTables(), clampToField(), deviceSummary(), drivePath(), engagedAutopilot(), limelightFix(), matchReadiness() (+15 more)

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
Cohesion: 0.50
Nodes (3): AppState, nt_frame(), nt_set()

### Community 44 - "paintNotices"
Cohesion: 0.22
Nodes (11): ago(), aimStickNotice(), assistNotice(), noticeKind(), openAlertPop(), paintAlertIndicator(), paintAlertPop(), paintNotices() (+3 more)

### Community 45 - "Components"
Cohesion: 0.50
Nodes (4): Components, Hub activation, The field view, The gauge

### Community 46 - "isWall"
Cohesion: 0.67
Nodes (3): floodInterior(), isWall(), seedCell()

### Community 49 - "mechanisms.js"
Cohesion: 0.11
Nodes (25): trackMechanisms(), ballAt(), createAimDebounce(), FEED_RATE, fitKeep(), hasMechanisms(), INTAKE_LOAD_AMPS, isEjecting() (+17 more)

### Community 50 - "runs.js"
Cohesion: 0.09
Nodes (30): controlWord(), recordRun(), addRun(), AIM_CODE, AIM_ERROR, AIM_FIELDS, AIM_NAMES, AIM_STATE (+22 more)

### Community 51 - "escapeHtml"
Cohesion: 0.16
Nodes (28): buildCanGroups(), buildCanProbes(), cameraStateWords(), canBusHtml(), canShapeOf(), coreNum(), coreRows(), duration() (+20 more)

### Community 52 - "can-model.js"
Cohesion: 0.14
Nodes (25): barWidth(), busIndex(), busKind(), BUSY_DEVICE_COUNT, contentionWarnings(), controllerGroup(), CONTROLLERS, ERROR_PASSIVE (+17 more)

### Community 53 - "createSurroundView"
Cohesion: 0.23
Nodes (12): createPanoramaRenderer(), parseDriverView(), CAMERA_ANCHORS, cameraAnchors(), nearestCameraAnchor(), feed(), sample(), createSurroundView() (+4 more)

### Community 54 - "demo-match.test.js"
Cohesion: 0.09
Nodes (18): HOPPER, RED_HUB, ROBOT, scoreTimeOfFlightAt, START_POSE, DEPOT, estimate(), FIELD (+10 more)

### Community 55 - "field3d.js"
Cohesion: 0.10
Nodes (19): BLUE, BOUNCE, CARPET, carve(), CHASE_EYE, CHASE_LOOK, loadFieldModel(), FILL_LIGHT (+11 more)

### Community 56 - "driver3d.js"
Cohesion: 0.13
Nodes (25): applyPose(), ARRIVED_S, buildMannequin(), clamp01(), createDriver(), createDriverStage(), resize(), tick() (+17 more)

### Community 57 - "robot3d.js"
Cohesion: 0.18
Nodes (23): pairPlaces(), BATTERY, buildCadRobot(), animate(), muzzleAt(), BUMPER_FADE_MS, PART, UP (+15 more)

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
Cohesion: 0.09
Nodes (22): [0.2.0] — 2026-08-05 — Impacts and swerve tiles., [0.3.0] — 2026-08-06 — In-place updates., [0.4.0] — 2026-08-06 — About page, layout portability, shortcuts, connection history, a read-only diagnostics MCP., [0.5.0] — 2026-08-06 — Settings, and the robot's own spec sheet., [0.5.1] — 2026-08-06 — The garage, properly., [0.6.0] — 2026-08-06 — What the robot is made to do., [0.7.0] — 2026-08-06 — Search, release notes, and documentation that is true., [0.8.0] — 2026-08-06 — Less text, more robot. (+14 more)

### Community 63 - "camera.rs"
Cohesion: 0.11
Nodes (17): camera_frame(), camera_identity(), IDENTITY_LIMIT, identity_name(), identity_url(), jpeg(), LIMIT, MAX_BYTES (+9 more)

### Community 64 - "createPark"
Cohesion: 0.16
Nodes (26): clampElevation(), closest(), createPark(), applyRobot(), applyShot(), currentShot(), draw(), finishFlight() (+18 more)

### Community 65 - "hub.js"
Cohesion: 0.27
Nodes (11): matchClock(), redHubActive(), redHubActive(), activeIn(), AUTO_S, clamp01(), hubPlan(), segmentAt() (+3 more)

### Community 66 - "calibration.js"
Cohesion: 0.29
Nodes (7): calibrationNames(), calibrationNotice(), calibrationNotices(), displayName(), finite(), runningText(), SUSPECT_PERCENT

### Community 67 - "paintRunList"
Cohesion: 0.31
Nodes (10): paintRunList(), paintRunMain(), paintRuns(), runBefore(), runTracesHtml(), describeChanges(), modeLabel(), runWhen() (+2 more)

### Community 68 - "surround-ui.js"
Cohesion: 0.32
Nodes (12): cameraRoster(), createSurroundPolicy(), cameraDemoAt(), cameraDemoRoute(), cameraDemoValues(), createCameraFrameSource(), createDemoCameraRenderer(), context() (+4 more)

### Community 69 - "finite"
Cohesion: 0.23
Nodes (16): atSpeed(), observe(), ringPush(), ringSpeed(), finite(), fixed(), metres(), numOf() (+8 more)

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

### Community 76 - "driver-cad.mjs"
Cohesion: 0.38
Nodes (6): contents(), DEFAULT_SOURCE, log(), main(), root, WANTED

### Community 77 - "hopper3d.js"
Cohesion: 0.18
Nodes (15): createHopperBalls(), drawn(), fedAt(), pickupAt(), pickupStart(), setCount(), step(), slotPosition() (+7 more)

### Community 78 - "core-format.js"
Cohesion: 0.60
Nodes (4): bytes(), level(), preEolState(), wearText()

### Community 79 - "overdrive.js"
Cohesion: 0.48
Nodes (4): createOverdriveDebounce(), OVERDRIVE_COOLDOWN_MS, OVERDRIVE_ENGAGE_MS, OVERDRIVE_WARP_MS

### Community 80 - "device3d.js"
Cohesion: 0.18
Nodes (16): paintCameraPart(), paintCoreHero(), partSize(), CLAY, createDeviceStage(), frame(), resize(), showModel() (+8 more)

### Community 81 - "Mode"
Cohesion: 0.33
Nodes (5): Mode, Gui, Help, Mcp, parse_args()

### Community 82 - "drawRunTraces"
Cohesion: 0.40
Nodes (5): drawRunTraces(), drawTrace(), tokenAlpha(), traceSegments(), valueRange()

### Community 83 - "buildRobot"
Cohesion: 0.31
Nodes (11): addBumpers(), arcPlate(), axle(), buildRobot(), extrudeUp(), ring(), roundedBox(), roundedRect() (+3 more)

### Community 84 - "update"
Cohesion: 0.14
Nodes (36): commonPrefix(), history(), motorRowsFromNt(), update(), accelLimitText(), ASSIST_WORDS, assistLevelText(), assistText() (+28 more)

### Community 86 - "createRobotModel"
Cohesion: 0.43
Nodes (7): bumperNumbers(), createRobotModel(), applyNumbers(), applySpec(), dropNumbers(), normalizeRobot(), weave()

### Community 87 - "release.mjs"
Cohesion: 0.11
Nodes (18): bare, built, dirty(), dryRun, env, files, head, installer (+10 more)

### Community 88 - "surround-panorama.test.js"
Cohesion: 0.48
Nodes (4): PANORAMA, panoramaSample(), panoramaYaw(), sector

### Community 92 - "setText"
Cohesion: 0.53
Nodes (6): setFlag(), setLevel(), setText(), setWidth(), writeCanBus(), writeCanPair()

### Community 95 - "createMotionFilter"
Cohesion: 0.20
Nodes (8): createMotionFilter(), updateTurn(), turnBetween(), direction(), turn(), createShots(), step(), smooth()

### Community 96 - "ref_node_assert"
Cohesion: 0.16
Nodes (6): compactFigure(), spacedLabel(), number(), readLoopTiming(), ROBOT_LOOP_KEY, createCameraIdentityGate()

## Knowledge Gaps
- **14 isolated node(s):** `@fontsource-variable/figtree`, `@tauri-apps/cli`, `catalyst-console`, `Gui`, `Mcp` (+9 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 614 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `update()` connect `update` to `ref_node_assert`, `hub.js`, `app.js`, `devices.js`, `Widgets`, `el`, `paintNotices`, `park-state.test.js`, `setText`, `paintParkInfo`, `mechanisms.js`, `hidePark`, `escapeHtml`, `overdrive.js`, `aim-target.test.js`, `createRunRecorder`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `update()` (e.g. with `Writing your own` and `poseAge()`) actually correct?**
  _`update()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@fontsource-variable/figtree`, `@tauri-apps/cli`, `catalyst-console` to the rest of the system?**
  _14 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `field-collision.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.03636363636363636 - nodes in this community are weakly interconnected._
- **Why does `Writing your own` connect `Widgets` to `update`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `createField()` (e.g. with `resize()` and `tick()`) actually correct?**
  _`createField()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `mcp.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.12100840336134454 - nodes in this community are weakly interconnected._