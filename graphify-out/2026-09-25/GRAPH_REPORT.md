# Graph Report - C:/Users/yu_th/dev/CatalystConsole  (2026-08-07)

## Corpus Check
- 32 files · ~84,184 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 716 nodes · 1355 edges · 49 communities (48 shown, 1 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 58 edges (avg confidence: 0.87)
- Token cost: 45,907 input · 48,834 output

## Community Hubs (Navigation)
- Field Collision Baking
- MCP Diagnostics Server
- Tauri Backend And Modes
- NetworkTables 4 Client
- Settings Panel Surface
- Component Registry Core
- Tauri App Configuration
- The Robot Spec Sheet
- Driver Station Log Parsing
- REBUILT Hub Schedule
- Rule 3: Never Invent Numbers
- Board Layout And Tiles
- NPM Package Scripts
- Capability Schema Definitions
- Capability Schema Definitions (Windows)
- Settings Storage And Camera
- Live Tuning And Auto Chooser
- Device Tree And Power Panel
- Layout Export And Import
- Rule 2: Never Impede Driving
- Link History And Header
- Capability Identifier Schema
- Capability Identifier Schema (Windows)
- Product Identity And Branding
- Permission Array Schema
- Permission Array Schema (Windows)
- Field Model And Rendering
- The Repaint Loop
- Window And Webview Schema
- Window And Webview Schema (Windows)
- One Console, Many Clients
- Field Geometry Transforms
- Capability Remote Schema
- Capability Remote Schema (Windows)
- Panel Stand-Down On Enable
- View Switching And Boot
- Vendored three.js And CSP
- Rule 1: Never Control Robot
- Capability Root Schema
- Capability Root Schema (Windows)
- Desktop Schema Root
- Windows Schema Root
- The Match Clock
- Static Dev Server
- Schema Default Values
- Schema Default Values (Windows)
- Interior Flood Fill
- Edge Rasterisation

## God Nodes (most connected - your core abstractions)
1. `buildSettings()` - 27 edges
2. `Nt4Client` - 24 edges
3. `Rule 3 — It never invents a number` - 24 edges
4. `update()` - 23 edges
5. `Rule 2 — Nothing it does may impede driving` - 22 edges
6. `run_session()` - 17 edges
7. `el()` - 16 edges
8. `Server` - 15 edges
9. `paintSettings()` - 15 edges
10. `NtValue` - 14 edges

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
- **Deriving the hub schedule** — docs_hub_schedule_six_segments, docs_hub_schedule_alternating_shifts, docs_hub_schedule_game_data_arrives_late, docs_hub_schedule_no_game_data_needed, src_app_shifts, src_app_inactivefirstalliance [EXTRACTED 1.00]
- **The spec sheet's absence discipline** — docs_robot_identity_missing_not_dashed, docs_robot_identity_library_absent_not_zero, docs_robot_identity_partial_plan_degrades, docs_robot_identity_demo_sheet_incomplete, readme_absence_is_not_a_dash [EXTRACTED 1.00]
- **The Settings panel's non-blocking contract** — docs_settings_nothing_applies, docs_settings_nothing_is_modal, docs_settings_it_stands_down, docs_settings_reset_arms_itself, docs_settings_search_in_place [EXTRACTED 1.00]
- **Rule 2 written into the markup itself** — src_index_settings_has_no_aria_modal, src_index_drop_chip_hidden_by_default, src_index_status_under_the_rows, src_index_paste_by_hand_floor [EXTRACTED 1.00]
- **The three rules restated across every surface** — docs_assets_banner_three_rules_as_the_product, src_index_three_rules_in_about, docs_readme_three_rules_restated, readme_rule_1_never_controls_the_robot, readme_rule_2_never_impedes_driving, readme_rule_3_never_invents_a_number [EXTRACTED 1.00]
- **One drawing rasterised at four sizes** — src_tauri_icons_icon_app_icon, src_tauri_icons_32x32_small_icon, src_tauri_icons_128x128_medium_icon, src_tauri_icons_128x128_2x_retina_icon [EXTRACTED 1.00]

## Communities (49 total, 1 thin omitted)

### Community 0 - "Field Collision Baking"
Cohesion: 0.04
Nodes (51): also, bboxCentre, binCells, broken, ceiling, clearanceMm, cols, cropLoX (+43 more)

### Community 1 - "MCP Diagnostics Server"
Cohesion: 0.11
Nodes (39): The advisory travels with the numbers, field_map says which paths it searched, JSON-RPC 2.0 over stdio, match_state.mode is null without a control word, NaN comes back as the string "NaN", Implemented without an MCP SDK, console_status.rtt_ms is null while disconnected, stdout carries protocol frames and nothing else (+31 more)

### Community 2 - "Tauri Backend And Modes"
Cohesion: 0.10
Nodes (44): AppHandle, Default, Signed releases, The diagnostics MCP server, I, Candidate address cycling, The read-only diagnostics MCP server, The team number lives in the backend config (+36 more)

### Community 3 - "NetworkTables 4 Client"
Cohesion: 0.13
Nodes (28): AtomicBool, AtomicI64, AtomicU64, Duration, Mutex, 20 Hz batched flush, type_name(), decode_value() (+20 more)

### Community 4 - "Settings Panel Surface"
Cohesion: 0.10
Nodes (34): The quiet update check, Alert hold, Bundled but switched off says exactly that, Nothing applies, Release notes are shown as plain text, never rendered, Searching leaves matches where they live, The Settings panel, section by section, Trail length applies on release (+26 more)

### Community 5 - "Component Registry Core"
Cohesion: 0.10
Nodes (26): The component registry, BIT, define(), demo, dispose(), ds, hist, imperial() (+18 more)

### Community 6 - "Tauri App Configuration"
Cohesion: 0.08
Nodes (25): https://github.com/TomAs-1226/CatalystConsole/releases/latest/download/latest.json, icons/icon.ico, nsis, app, security, windows, withGlobalTauri, build (+17 more)

### Community 7 - "The Robot Spec Sheet"
Cohesion: 0.13
Nodes (21): A builder for the facts no API can answer, Copy the spec sheet, Derived rather than passed in, Bumper diagonal and channels used, The Catalyst group leads the sheet, Gear ratios and mass are the exceptions, Nothing has to be republished, One line of adoption (+13 more)

### Community 8 - "Driver Station Log Parsing"
Cohesion: 0.20
Nodes (19): A quiet session is not an unreadable file, Driver Station logs, The .dslog parser fails closed, classify(), default_log_dir(), DsEvent, DsSamples, DsSession (+11 more)

### Community 9 - "REBUILT Hub Schedule"
Cohesion: 0.15
Nodes (17): The board, suggested rather than drawn, Alternating shifts 1-4, Game data is empty until after auto, The hub schedule, Auto, transition and end game need no game data, Six teleop segments, Table 6-2, Published-and-empty is not absent, The widget catalogue (+9 more)

### Community 10 - "Rule 3: Never Invent Numbers"
Cohesion: 0.20
Nodes (17): Absent is not zero, alerts returns null, not an empty list, Failure, quietly and without lying, The demo sheet is deliberately incomplete, The library omits rather than zeroes, Why a missing fact is missing rather than dashed, Partial figures give a partial drawing, Demo data is amber, alone among the switches (+9 more)

### Community 11 - "Board Layout And Tiles"
Cohesion: 0.18
Nodes (17): Reset arms itself rather than opening a dialog, buildBoard(), clock(), copyText(), defaults(), el(), findSpace(), installDrag() (+9 more)

### Community 12 - "NPM Package Scripts"
Cohesion: 0.12
Nodes (16): description, devDependencies, @tauri-apps/cli, three, name, private, scripts, build (+8 more)

### Community 13 - "Capability Schema Definitions"
Cohesion: 0.12
Nodes (16): anyOf, description, definitions, Application, Number, PermissionEntry, Target, Value (+8 more)

### Community 14 - "Capability Schema Definitions (Windows)"
Cohesion: 0.12
Nodes (16): anyOf, description, definitions, Application, Number, PermissionEntry, Target, Value (+8 more)

### Community 15 - "Settings Storage And Camera"
Cohesion: 0.19
Nodes (15): One camera, two surfaces, one function, Storage is read one key at a time and every key is checked, The chase camera swings around occluding field elements, Settings storage is validated key by key, applyFieldCamera(), CAMERAS, clamp(), loadSettings() (+7 more)

### Community 16 - "Live Tuning And Auto Chooser"
Cohesion: 0.18
Nodes (15): Auto chooser, The tunables manifest, arcPath(), clamp01(), distinctLabels(), fmt(), history(), leaf() (+7 more)

### Community 17 - "Device Tree And Power Panel"
Cohesion: 0.21
Nodes (14): A count and a list answer different questions, The Devices section, The power board is drawn only from a published channel count, applyFrame(), demoTick(), escapeHtml(), has(), num() (+6 more)

### Community 18 - "Layout Export And Import"
Cohesion: 0.21
Nodes (14): An import is checked whole before anything is applied, Layout export and import, applyLayoutText(), downloadText(), exportLayoutToFile(), importLayoutFromFile(), layout, layoutFilename() (+6 more)

### Community 19 - "Rule 2: Never Impede Driving"
Cohesion: 0.21
Nodes (13): The three rules set in monospace on the banner, Documentation index, The three rules, restated in the docs index, About lays the three rules across on a wide window, Nothing is modal, Every binding is a single unmodified key, Field render cost control, The /FMSInfo write guard (+5 more)

### Community 20 - "Link History And Header"
Cohesion: 0.19
Nodes (13): The plan is not painted in the alliance colour, alliance(), clockOfDay(), duration(), linkDrops(), linkSource(), linkText(), observeLink() (+5 more)

### Community 21 - "Capability Identifier Schema"
Cohesion: 0.15
Nodes (13): properties, Identifier, description, oneOf, type, default, description, type (+5 more)

### Community 22 - "Capability Identifier Schema (Windows)"
Cohesion: 0.15
Nodes (13): properties, Identifier, description, oneOf, type, default, description, type (+5 more)

### Community 23 - "Product Identity And Branding"
Cohesion: 0.20
Nodes (12): The console's own palette, The project banner, Bundled with the Catalyst desktop app, Installing Catalyst Console, Alert group topics, Catalyst Console, Competition legality, FrcCatalyst (+4 more)

### Community 24 - "Permission Array Schema"
Cohesion: 0.17
Nodes (12): $ref, array, null, description, items, type, uniqueItems, description (+4 more)

### Community 25 - "Permission Array Schema (Windows)"
Cohesion: 0.17
Nodes (12): $ref, array, null, description, items, type, uniqueItems, description (+4 more)

### Community 26 - "Field Model And Rendering"
Cohesion: 0.24
Nodes (9): The optional field bakes, The baked field model, Field material re-grounding, The procedural field outline, root, scratch, vendor, bakedAssets (+1 more)

### Community 27 - "The Repaint Loop"
Cohesion: 0.27
Nodes (10): update must be cheap and must not throw, A stored board that cannot be read does not take the console with it, Chromium stops rAF for an occluded window, The 10 Hz paint timer, activeView(), DEFAULT_LAYOUT, loadLayout(), paint() (+2 more)

### Community 28 - "Window And Webview Schema"
Cohesion: 0.20
Nodes (10): type, webviews, windows, items, description, items, type, description (+2 more)

### Community 29 - "Window And Webview Schema (Windows)"
Cohesion: 0.20
Nodes (10): type, webviews, windows, items, description, items, type, description (+2 more)

### Community 30 - "One Console, Many Clients"
Cohesion: 0.31
Nodes (9): The standalone installer, Two NetworkTables clients are ordinary, NetworkTables, One console at a time, The 128px @2x application icon, The 128px application icon, The 32px application icon, The application icon (+1 more)

### Community 31 - "Field Geometry Transforms"
Cohesion: 0.31
Nodes (9): apply(), boundsOf(), identity(), instanceCount(), instanceMatrix(), isLooseGamePiece(), multiply(), placementPoints() (+1 more)

### Community 32 - "Capability Remote Schema"
Cohesion: 0.22
Nodes (9): description, properties, required, type, CapabilityRemote, urls, urls, description (+1 more)

### Community 33 - "Capability Remote Schema (Windows)"
Cohesion: 0.22
Nodes (9): description, properties, required, type, CapabilityRemote, urls, urls, description (+1 more)

### Community 34 - "Panel Stand-Down On Enable"
Cohesion: 0.43
Nodes (8): It stands down, Settings stands down when the robot goes live, closeOverlays(), isLive(), MODALS, overlayOpen(), settingsOpen(), standDownOverlaysOnEnable()

### Community 35 - "View Switching And Boot"
Cohesion: 0.25
Nodes (8): Opens on applies at launch only, BOOT, onShow(), settings, showView(), wireTablist(), The four views, The tablist is one tab stop with arrow keys inside it

### Community 36 - "Vendored three.js And CSP"
Cohesion: 0.38
Nodes (6): Building from source, Strict CSP and vendored three.js, files, out, root, The import map points three at the vendored copy

### Community 37 - "Rule 1: Never Control Robot"
Cohesion: 0.47
Nodes (6): Diagnosis has never needed control, There is no drive tool, and there will not be one, NI Driver Station, Rule 1 — It never controls the robot, The second control path hazard, The steering wheel motif

### Community 38 - "Capability Root Schema"
Cohesion: 0.33
Nodes (6): description, required, type, Capability, identifier, permissions

### Community 39 - "Capability Root Schema (Windows)"
Cohesion: 0.33
Nodes (6): description, required, type, Capability, identifier, permissions

### Community 40 - "Desktop Schema Root"
Cohesion: 0.40
Nodes (4): anyOf, description, $schema, title

### Community 41 - "Windows Schema Root"
Cohesion: 0.40
Nodes (4): anyOf, description, $schema, title

### Community 42 - "The Match Clock"
Cohesion: 0.67
Nodes (4): /FMSInfo carries no match clock, /FMSInfo topics, Match clock topic fallback chain, matchTime()

### Community 43 - "Static Dev Server"
Cohesion: 0.50
Nodes (3): port, root, TYPES

### Community 44 - "Schema Default Values"
Cohesion: 0.50
Nodes (4): default, description, type, description

### Community 45 - "Schema Default Values (Windows)"
Cohesion: 0.50
Nodes (4): default, description, type, description

### Community 46 - "Interior Flood Fill"
Cohesion: 0.67
Nodes (3): floodInterior(), isWall(), seedCell()

## Ambiguous Edges - Review These
- `Rule 1 — It never controls the robot` → `The steering wheel motif`  [AMBIGUOUS]
  src-tauri/icons/icon.png · relation: conceptually_related_to
- `One console at a time` → `The 32px application icon`  [AMBIGUOUS]
  src-tauri/icons/32x32.png · relation: conceptually_related_to

## Knowledge Gaps
- **196 isolated node(s):** `name`, `version`, `private`, `description`, `vendor` (+191 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Rule 1 — It never controls the robot` and `The steering wheel motif`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `One console at a time` and `The 32px application icon`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `The baked field model` connect `Field Model And Rendering` to `Settings Panel Surface`?**
  _High betweenness centrality (0.132) - this node is a cross-community bridge._
- **Why does `The optional field bakes` connect `Field Model And Rendering` to `Field Collision Baking`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Why does `probeAssets()` connect `Settings Panel Surface` to `Field Model And Rendering`, `Component Registry Core`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `Rule 3 — It never invents a number` (e.g. with `Failure, quietly and without lying` and `Bundled but switched off says exactly that`) actually correct?**
  _`Rule 3 — It never invents a number` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `Rule 2 — Nothing it does may impede driving` (e.g. with `Every binding is a single unmodified key` and `Alerts are held after they clear`) actually correct?**
  _`Rule 2 — Nothing it does may impede driving` has 7 INFERRED edges - model-reasoned connections that need verification._