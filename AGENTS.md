# AGENTS.md: Catalyst Console

Instructions for AI coding agents working in this repo: Claude Code, and whatever model runs
when Claude isn't available. For humans, `README.md` is the guide.

## What this is

A driver station companion dashboard for FrcCatalyst robots, built on Tauri 2:

- **Rust backend:** an NT4 client, the `.dslog` / `.dsevents` parsers, and a read-only diagnostics
  MCP server behind `--mcp`.
- **Frontend:** plain HTML/CSS/JS, with no framework or bundler.

Active work is on `systemcore` (the 2027 port); `main` is the 2026 line. Run
`git branch --show-current` first. README "Layout of the source" maps the files.

## The three rules

Every change must keep all three.

1. **Never controls the robot.** Only the NI Driver Station may hold the robot connection, so no
   code path opens it. The only writes are ordinary dashboard writes, and `nt_set` refuses
   `/FMSInfo`. The MCP server is read-only by design; don't add a tool that writes.
2. **Nothing may impede driving.** No modal blocks the board and no check gates anything. It paints
   on a 10 Hz timer because Chromium stops `requestAnimationFrame` for occluded windows.
3. **Never invent a number.** A topic that isn't published shows a dash. The parsers fail closed on
   versions they don't recognise.

## Commands

- `npm install`, then `npm run vendor`. The vendor step copies three.js into `src/vendor/`, because
  the CSP forbids CDNs.
- `npm test` runs `node --test "src/**/*.test.js"`.
- `npm run serve` serves `src/` on :5173 for UI work without rebuilding Rust.
- `npm run dev` runs the app; `npm run build` builds it.
- CatalystApp bundles the built binary from `src-tauri/target/{release,debug}/catalyst-console.exe`,
  so keep that binary name.

## Docs

The docs are `README.md` plus `docs/`. `docs/README.md` is the index, and the README's
"Documentation" table lists the same pages.

- **Moving or renaming a page:** update both lists, and any link into a README heading. For example,
  `docs/README.md` links to `../README.md#the-contract-with-the-robot`, so renaming that heading
  breaks the link.
- **Topic names:** document the robot contract with the topic names exactly as the code reads them.

## Git and files

- Don't commit, push, tag or release unless the user asks for it in the current session.
- `origin` is GitHub only for now, because Forgejo mirroring hasn't been added to this repo yet.
- `latest.json` and `src/vendor/` are generated and gitignored.
- Files are UTF-8 without a BOM. In Windows PowerShell 5.1, don't round-trip them through
  `Get-Content` / `Set-Content`: that adds a BOM or garbles `—` and `·`. Use an editor tool, or .NET
  `ReadAllText` / `WriteAllText`.

## If you are a fallback model

Fine to take on: docs and README edits, the settings and widgets reference pages, and link fixes.

Stop and leave notes for Claude on: anything in `src-tauri/`, write paths, the MCP tool surface, or
the three rules.
