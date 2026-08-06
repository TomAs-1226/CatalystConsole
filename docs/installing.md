# Installing Catalyst Console

Three ways in, in the order most teams should pick.

## 1. With the Catalyst desktop app (easiest)

Install [**Catalyst**](https://github.com/TomAs-1226/CatalystApp/releases/latest) and the console comes
with it. A **Driver Console** entry appears in the sidebar and on the home screen; clicking it opens
the dashboard. Nothing else to download, and the two stay in step.

## 2. Standalone installer

Grab `Catalyst Console_x.y.z_x64-setup.exe` from
[Releases](https://github.com/TomAs-1226/CatalystConsole/releases/latest) and run it. About 3 MB. It
puts a Start Menu entry and a desktop shortcut in place.

Use this if you want the console on a driver station laptop without the developer tooling — which is
the usual case for the machine that actually runs matches.

## 3. From source

```bash
git clone https://github.com/TomAs-1226/CatalystConsole
cd CatalystConsole
npm install
npm run vendor
npm run build
```

You need [Rust](https://rustup.rs) and the WebView2 runtime, which ships with Windows 11.

`npm run vendor` copies three.js into `src/vendor/`. It has to run before the first build: the
webview runs under a strict CSP with `script-src 'self'`, so nothing loads from a CDN. A dashboard
that needs the internet to draw a field is a dashboard that fails in exactly the venue it is meant for.

### The field model, optionally

```bash
npm run field-cad        # bake the KOP field CAD down to something a dashboard can carry
npm run field-collision  # derive collision geometry from it
```

Both are optional. Without them the field view draws itself from published dimensions, which is what
renders on a machine that has never seen the CAD.

## First run

The console finds the robot on its own, cycling these until one answers:

| Address | When |
| --- | --- |
| `127.0.0.1` | simulation on this machine |
| `roborio-TEAM-frc.local` | on the field, over mDNS |
| `10.TE.AM.2` | in the pit, static IP |
| `172.22.11.2` | USB tether |

Click the link chip in the top strip to set your team number. It is remembered.

**One console at a time.** Launching it again raises the window already open rather than starting a
second — two consoles would mean two NetworkTables clients on one robot.

## Is it legal at competition?

Yes. It is a dashboard: it connects to NetworkTables and displays what it finds, the same as
Shuffleboard, Glass, Elastic and AdvantageScope. It does not touch the DS protocol and does not open a
second control connection. Check the current manual as always, but nothing here is outside what a
dashboard normally does.