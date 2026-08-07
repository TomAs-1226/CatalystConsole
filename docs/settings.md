# Settings

Everything the console lets you change about itself, in one panel. It replaced the modals that used
to hang off the chips in the top strip — a team-number one, a layout one — and the About page with
them, so there is one place to look and one place to change.

Open it with the gear, or **S**. Three other things land inside it: the link chip goes to **Robot**
with the team field focused, **L** goes to **Dashboard**, and the wordmark, **?** and **F1** go to
**About**.

## How it behaves

**Nothing applies.** There is no apply button and no confirmation step, because a control is the
truth the moment you move it. The surface that changed a setting is responsible for making the board
agree with it, and does so immediately.

**Nothing is modal.** No focus trap, no inert dashboard behind it, and the markup does not claim
otherwise. It is a mode you step out of rather than a window that holds you.

**It stands down.** The moment the robot is enabled or E-stopped the panel closes itself, along with
anything else covering the board. Rule two: a driver who opened Settings in the pit and then got
called to the field must not find the state lamp, the match timer and the E-stop indicator behind a
panel. Nothing the console has to say about itself is worth reading at the moment a robot goes live.

## Searching

Fifteen settings across seven sections is past the point where remembering which one holds what is
free, so the box above the rail filters every row in every section at once.

Matches stay where they live. Nothing is cloned into a results list — the row you find is the row
itself, with the handler it was built with, so a setting found by searching is changed exactly the
same way as one found by navigating. Section headings stay for context; the section leads, the notes
and the garage card are hidden while a filter is up, because they are page furniture rather than
settings.

The label, its explanation and any text on the control are all searched, so *imperial* finds Units
through the segmented control rather than through the label. It matches the words that are on screen
and nothing else — there are no synonyms, so *inches* finds nothing even though inches are what
Imperial means. A query that matches nothing says so, quoting what you typed.

Escape in the box clears the filter and leaves the panel open; a second Escape closes the panel.
Picking a section from the rail also drops the filter, since a section chosen while a filter is up
would be hidden by it.

About holds prose rather than rows, so it never matches and never claims to.

## Robot

Which robot the console looks for, and what it says about itself.

The **spec sheet** at the top is the robot's own account of itself, and is the whole of
[the garage](robot-identity.md). It is not configurable — it fills in when a robot that publishes one
connects, and stays on its empty state when none does.

| Row | What it does |
| --- | --- |
| **Units** | metric or imperial, for the sheet above. A display choice only: the robot publishes SI and nothing on the wire changes. FRC writes its frame and height rules in inches, which is the reason it is offered. |
| **Team number** | sets the addresses below. Kept by the app rather than the browser, so every layout on the machine looks for the same robot — and so `--mcp` reads the same answer. Applies on the next connection attempt, about a second away while disconnected. |
| **Addresses tried** | the four candidates in the order they are cycled, with the one that answered marked. Not editable; it is derived from the team number. |

Without a backend — under `npm run serve` — the team field is disabled and says so, because the
number belongs to the desktop app.

## Devices

Its own section rather than a footnote to the spec sheet. The sheet answers "what is this robot"; this
answers "what is on it and where", which is a different question asked at a different time.

**CAN devices** are drawn as a tree, one group per bus, ids down the side. It needs a robot on
FrcCatalyst 1.12 or later, which publishes `Hardware/Devices` as `bus|id|type`. The ordering is the
library's — it sorts by bus and then numerically by id before publishing, and the console renders the
list as it arrives, so a tree that comes out jumbled is a robot-side question and not a console one.
Earlier versions publish only the count and the by-type inventory, both of which still appear on the
spec sheet under Robot.

**Power distribution** is drawn as the board: every slot the robot said it has, the taken ones filled,
and the channel map underneath. It appears only when the robot published a channel count — a strip
sized to whatever happens to be in use would be inventing the shape of a distribution board nobody
described.

Neither half is a setting, so neither is reachable by search. If the robot published nothing for
either, the section says so.

## Field view

How the field tile draws. Every change lands on the tile as you make it.

| Row | What it does |
| --- | --- |
| **Camera** | chase, overhead or free. The buttons in the tile's own corner move this same setting; there is one camera and both surfaces go through one function to change it. |
| **Trail length** | how much of the path behind the robot is kept, 0 to 400 points. Zero draws none. Applied on release rather than during the drag: the trail buffer is allocated when the scene is built, so the length is a rebuild. |
| **Baked field model** | draws the official field CAD when a build has one bundled. Off, the tile keeps the procedural outline, which costs a fraction as much on an older laptop and tells the driver the same thing. |

## Dashboard

The board itself.

| Row | What it does |
| --- | --- |
| **Opens on** | which view the console comes up in — Dashboard, Tune, Logs or Topics. Applied at launch only; setting it does not switch the view now, because that would be the setting acting on the wrong occasion. |
| **Export the layout** | plain JSON, to a file or to the clipboard. Commit it beside your robot code and every laptop in the pit comes up with the same board. |
| **Import a layout** | from a file or the clipboard. Checked whole before anything is applied: a document with one bad tile is refused with the reason, and the board on screen is left alone. |
| **Paste it in by hand** | the floor under the row above, for a machine where neither the file dialog nor the clipboard is available. |
| **Reset the board** | back to the layout the console ships with. Two presses rather than a dialog — the button arms itself and disarms after four seconds — because rule two says nothing blocks the board. |
| **Alert hold** | how long a cleared alert stays on screen, dimmed, 0 to 8 s. Applied live on the drag, since nothing has to be rebuilt for it. Robot alerts sitting near their threshold raise and clear repeatedly, and a tile that strobes next to a driver is worse than useless. |

What happened to the last import or reset is written under the rows rather than inside one. A row
says what a control does; what happened when you used it is the section speaking.

## Data

One switch, **Demo data**, which feeds every tile from a synthetic robot: twenty seconds of auto then
teleop counting down, with a drivetrain, a battery under load, a pose driving a circle, and a spec
sheet for a robot called *Demo robot*.

It is amber rather than blue, alone among the switches here. It is off by default and never
remembered, the dock button stays lit the whole time it runs, and switching it on stands this panel
down exactly as a robot enabling does. A dashboard that quietly invents telemetry is a hazard, so
every part of that is deliberate.

The same switch is in the dock, and that duplication is on purpose: while demo runs, the fact that
the numbers are invented has to be visible on the dashboard itself rather than filed away behind a
panel nobody has open.

## Updates

Looked for once at launch, quietly, and after that only when you ask.

| Row | What it does |
| --- | --- |
| **Installed version** | read from the application itself, never typed into the interface. |
| **Check for an update** | asks GitHub for the latest release. |

When there is a release to take, its **notes are shown here before you decide** — the page is a
decision rather than a changelog, so nothing appears for the version already installed. The text
arrived over the network, so it is shown as plain text and never rendered as markup.

**Install** is always a deliberate click. It downloads, installs and restarts, which is not something
to do to somebody who did not ask for it and least of all mid-match. When an update exists a chip
also appears in the dock; there is no prompt and no dialog anywhere in this path.

A driver station is usually on a field network with no route to the internet, so a check that fails
is the normal case and not a fault. The page says so plainly and nothing else changes.

## About

The last section rather than a destination of its own, because a product explaining itself is the end
of the manual. On a window 1080px or wider the three rules sit side by side rather than stacked, so
they are read across rather than scrolled through: they are one idea in three parts, and a reader who
has to scroll to reach the third has stopped holding the first two. Narrower than that there is no
longer room for a decent measure and it folds back to one column, keyboard and links along with it.

**Live diagnostics** are read rather than stated: what the console is connected to, round trip,
topic count, how long it has been running, how many NetworkTables frames have arrived, and how many
times the link has dropped. Frames counts real ones only — demo ticks are not NetworkTables frames,
and counting them would be the console inventing a number about itself.

Beside them, whether this build bundles the baked field model and the collision map. A model that is
bundled but switched off says exactly that, rather than reporting a preference as a fact about the
build.

**Keyboard**, in full:

| Key | |
| --- | --- |
| `1` `2` `3` `4` | Dashboard, Tune, Logs, Topics |
| `S` | Settings |
| `D` | demo data on or off |
| `E` | edit layout |
| `A` | add a component |
| `L` | Settings, on the layout |
| `?` or `F1` | Settings, on About |
| `Esc` | close whatever is open |

Every binding is a single unmodified key, because a driver station is operated under pressure and
often without looking down. That is exactly why typing in any field suspends them all: a bare `d`
must never toggle demo data while somebody is halfway through typing a topic path. Escape in a field
means *abandon what I am typing* and blurs it; a second Escape then closes what is open.

## Where it is kept

Local storage, in one object, except the team number — that belongs to the backend, in the app's own
config directory, because the MCP server has to read it with no webview involved.

Storage is read one key at a time and every key is checked. A number outside its range is pulled back
into it and anything else falls back to the default, because storage can hold anything — an older
build wrote it, someone edited it by hand, a quota error truncated it — and a bad value out of there
lands in a component that has no business validating a setting.
