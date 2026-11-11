# tools waze

Waze from the terminal and as an MCP server: police and every other report along a whole trip, routes with ETA and
alternatives, jams, the best departure time, exports, a local history with police hotspots, and Waze's official deep
links. It reads the Waze live map through one background tab in your own Brave, so it needs no account and no API key.

> **Waze hides user reports today.** Since at least 2026-11-01 the live map answers road closures only: police,
> accident, hazard and camera lists stay empty whatever is on the road. Routes, ETAs, departure times, jams and
> closures still work. See [User reports are hidden](#user-reports-are-hidden).

## Quick start

```bash
tools chrome-devtools restart --browser brave --port 9222   # quits Brave, relaunches it with remote debugging
tools waze doctor                                            # read-only: browser, tab, token, one georss call
tools waze police Praha Brno                                 # police on the corridor, km from the start, age, side
tools waze route Praha Brno --alternatives                   # ETA, alternatives, every report and jam on the route
tools waze depart Praha Brno --at "tomorrow 07:00" --window 3   # best 15-minute departure
tools waze link Brno --from Praha                            # official waze.com/ul links, no browser tab
```

The first command quits your Brave and starts it again; session restore usually brings the tabs back. Run it when
`doctor` says that no browser answers, which happens each time Brave starts without remote debugging.

A place is a name (`Brno`, `"Brno hlavní nádraží"`), an address, or `"lat,lon"` (`"50.08,14.43"`), which is used as
given. An area also takes a box `"south,west,north,east"` (four numbers).

## Commands

Global options go before the command, for example `tools waze --json route Praha Brno`.

| Option | What it does |
|---|---|
| `--json` | Print the result data as JSON |
| `--port <port>` | Browser CDP port (default 9222) |
| `--keep-tab` | Leave the live-map tab open; the next run reuses it |
| `-v, --verbose` | Verbose logging |
| `--readme` | Print this README |

On a terminal, the report and jam lists (`alerts`, `police`, `route`, `jams`, `near`) print boxed tables when they
have rows. Other results, and every result that is piped or redirected, print Markdown. `doctor` always prints a
boxed table.

A flag shown as `[value]` (`--type`, `--format`, `--category`) opens a picker when you give it bare in a terminal.
An unknown value always prints the allowed values and exits 1, and so does a bare flag without a terminal.

Report types for `--type` and `--category`: `police`, `accident`, `hazard`, `jam`, `closure`, `camera`, `other`. With
`--type`, a police report with a mobile speed camera counts as both `police` and `camera`. `hotspots --category`
counts each report under its one stored category, so that report counts as `police` only. The `jam` type is a jam
that a driver reported. The traffic jams that Waze computes are a separate feed: the `jams` command and the jam
tables.

### Trips

`police`, `route`, `export` and `watch` plan the route through Waze first, then scan the georss tiles along it.
`depart` only plans the route and reads the departure times that Waze returns, so it sends no georss requests.

```bash
tools waze police Praha Brno                                  # police only
tools waze route Praha Brno --alternatives                    # also Waze's no-vignette routes
tools waze route "50.08,14.43" Plzeň --type police,accident --corridor 300
tools waze route Praha Brno --at 17:30                        # arrival times for a later departure
tools waze depart Praha Brno --at "tomorrow 07:00" --window 3 # predicted drive time per 15-minute departure
tools waze export Praha Brno --format gpx -o trip.gpx         # geojson, gpx, kml, csv
tools waze watch Praha Brno --interval 2m                     # notify on each new police or accident report
tools waze watch Praha Brno --type police --count 30 --no-notify
```

| Command | What it does |
|---|---|
| `police <from> <to>` | Police reports on the corridor: km from the start, age, side, street |
| `route <from> <to>` | Routes with ETA, every report and jam on the corridor, a live-map link |
| `depart <from> <to>` | Predicted drive time for each 15-minute departure in a window |
| `export <from> <to>` | The route with its reports and jams as GeoJSON, GPX, KML or CSV |
| `watch <from> <to>` | Polls the corridor and notifies on each new report (Ctrl-C stops) |

Flags shared by `police`, `route`, `export` and `watch`:

| Flag | What it does |
|---|---|
| `--corridor <metres>` | How far from the route a report may be (default 150, 20 to 3000) |
| `--no-vignette` | Plan without vignette motorways; `depart` has it too |

Flags of one command:

| Flag | What it does |
|---|---|
| `route --alternatives` | Also list the no-vignette routes beside the fastest one |
| `route --type [types]` | Only these report types (comma list); `export` has it too |
| `route --at <when>` | Departure time; the arrival times follow it |
| `depart --at <when>` | Earliest departure (default now) |
| `depart --window <hours>` | Hours of departures to compare (default 4, 0.5 to 24) |
| `export --format [format]` | `geojson` (default), `gpx`, `kml`, `csv` |
| `export -o, --output <file>` | Write to a file instead of stdout |
| `watch --interval <time>` | `90s`, `2m`, `1h`, or bare minutes (default 2m, at least 30s) |
| `watch --type [types]` | Report types that notify (default `police,accident`) |
| `watch --count <n>` | Stop after this many polls |
| `watch --say` | Also speak each notification (speaks nothing today, see Troubleshooting) |
| `watch --no-notify` | Print only, no macOS notification |

A time for `--at` is `now`, `HH:MM` (today, or tomorrow when that time has passed), `"tomorrow HH:MM"`, an ISO
date-time (`2026-12-24T08:00`), or epoch milliseconds.

How the trip commands behave:

- **`route`** prints four parts: the routes (via, distance, time, arrival, source, traffic), the reports on the route,
  the jams on the route, and an "Open in Waze" live-map link.
- **`depart`** compares the departure times that Waze's planner returns. When Waze routing fails and the OSRM fallback
  draws the route, there are no departure times.
- **`export`** writes the route line and every report as a point. GeoJSON and KML also hold every jam as a line, and
  CSV holds one row per report or jam. GPX has a waypoint per report and a track for the route, and no jams. The CSV
  columns are `kind`, `km`, `category`, `type`, `subtype`, `label`, `street`, `lat`, `lon`, `offset_m`, `side`,
  `published_at` and `thumbs_up`. When coverage is incomplete (capped, failed or unasked tiles) or Waze hides user
  reports, the warnings go to stderr, so the file or a piped stdout stays a valid document. GeoJSON, GPX and KML
  also carry them in their own metadata. CSV has no place for them, so read `warnings` from `--json`.
- **`watch`** plans the route once, then polls the reports feed (not the jams feed). The first poll lists the
  matching reports already on the route and sends no notification. Each later poll notifies only reports it has not
  seen. A failed poll prints a warning and the watch goes on. With `--json` it prints one result per poll (`poll`,
  `at`, `new`, `onRoute`, `stats`).

### Areas

```bash
tools waze alerts Praha --radius 3 --type police   # reports around a place, nearest first
tools waze alerts "49.9,14.2,50.2,14.7"            # or inside a box: south,west,north,east
tools waze jams Brno --min-level 3                 # jams around a place
tools waze jams --from Praha --to Brno             # jams along a trip
tools waze near "Václavské náměstí"                # everything within 2 km
```

| Command | What it does |
|---|---|
| `alerts <area>` | Reports around a place or in a box, nearest first |
| `jams [area]` | Traffic jams around a place or in a box |
| `jams --from <place> --to <place>` | Traffic jams along a trip |
| `near <place>` | Every report and jam within a small radius, and a live-map link |

| Flag | What it does |
|---|---|
| `--radius <km>` | Radius around a place: default 5 (`alerts`, `jams`) or 2 (`near`) |
| `alerts --type [types]` | Only these report types (comma list) |
| `alerts --limit <n>` | Most reports to list (default 100, at most 2000) |
| `jams --min-level <n>` | Lowest Waze jam level, 0 to 5 (default 0) |
| `jams --corridor <metres>` | Trip corridor width (default 150) |

The radius is 0.1 to 100 km, and at most 50 km for `near`. A box ignores `--radius`.

Along a trip, a jam counts when at least two of its points lie within 40 m of the route (or within `--corridor`, when
that is smaller) and it advances along the route by at least 60% of its own length. That drops crossing streets, slip
roads and the opposite carriageway.

### Places and links

```bash
tools waze geocode "Brno hlavní nádraží"           # name to coordinates
tools waze geocode "49.19,16.61"                   # coordinates to a street address
tools waze venues parking --near Brno              # Waze place search; ids feed `venue`
tools waze venue venues.10000001.100000011.100001  # one venue card
tools waze link Brno --from Praha                  # deep links, no browser tab
tools waze open Brno --from Praha                  # opens the live map with the route
```

| Command | What it does |
|---|---|
| `geocode <query>` | A name to coordinates (Waze, then OpenStreetMap); `"lat,lon"` to an address |
| `venues <query>` | Waze place search: name, address, distance, venue id |
| `venue <id>` | One venue card: address, phone, web, services, opening hours, a navigate link |
| `link <to>` | A `waze.com/ul` navigate link; with `--from`, also a live-map directions link |
| `open <to>` | Opens the link in your default browser and prints it |

| Flag | What it does |
|---|---|
| `venues --near <place>` | Search around this place |
| `venues --limit <n>` | Most results (default 10, at most 20) |
| `link --from <place>` | Also print a live-map directions link from here; `open` has it too |
| `link --no-navigate` | Show the place without starting navigation |

- `venue` takes a `venues.…` id. A `googlePlaces.…` id has no Waze venue card and is refused. The card also lists
  the other venues at the same address.
- `link` and `open` use no live-map tab and call no Waze API. A named destination goes into the link as text
  (`?q=`), and Waze resolves it when you open the link. With `--from`, both ends are looked up on OpenStreetMap
  Nominatim to draw the directions link.
- `open` opens the directions link when `--from` is given and both ends resolve, and the navigate link otherwise. It
  uses `open` on macOS, `explorer` on Windows and `xdg-open` on other systems.

### History

```bash
tools waze record Praha --radius 15                # snapshot of the reports around a place
tools waze record --from Praha --to Brno           # snapshot of a trip corridor
tools waze history                                 # recorded snapshots, newest first
tools waze hotspots --since 30                     # police hotspots by place and hour of day
tools waze hotspots --category accident --cell 2
```

| Command | What it does |
|---|---|
| `record [area]` | Saves the reports around a place or in a box to the local history |
| `record --from <place> --to <place>` | Saves the reports along a trip |
| `history` | Snapshots with their report, police and jam counts, and the totals |
| `hotspots` | Grid cells with the most distinct reports, their busiest hours, a chart by hour |

| Flag | What it does |
|---|---|
| `record --radius <km>` | Radius around a place (default 10) |
| `record --corridor <metres>` | Trip corridor width (default 150) |
| `history --limit <n>` | Most snapshots (default 20, at most 500) |
| `hotspots --category [category]` | Report category (default police) |
| `hotspots --since <days>` | Only reports published in the last N days |
| `hotspots --cell <km>` | Grid cell size (default 1, 0.1 to 20) |
| `hotspots --limit <n>` | Most places (default 15, at most 100) |

- `record` saves every report type. A report seen in several snapshots is stored once, with its first and last
  sighting and a sighting count, so `hotspots` counts distinct reports.
- `hotspots` reads only what `record` saved. Record the same area or trip many times to build a history. While Waze
  hides user reports, a snapshot holds closures only, so police hotspots stay empty.
- The hours in `hotspots` are local to your time zone.
- `history` and `hotspots` open no browser tab and never create the database.

### Diagnostics and MCP

```bash
tools waze doctor                                  # read-only health check
tools waze --keep-tab police Praha Brno            # leave the tab open: the next run starts faster
tools waze --json route Praha Brno                 # machine-readable result
tools waze mcp                                     # stdio MCP server
```

| Command | What it does |
|---|---|
| `doctor` | Read-only check of the browser, the tab, Waze and the history store |
| `mcp` | Starts the stdio MCP server (see [For agents](#for-agents)) |

`doctor` checks the browser port, the live-map tab, the user-reports flag, one token mint, one georss call over
central Prague, and the history store. It prints a fix line for a failed check and exits 1 when a check fails. It
writes nothing durable: it reuses a kept tab and leaves it open, closes a temporary tab, never writes the kept-tab
file, and only looks at the database (it never creates or migrates it).

## How it works

### How it reaches Waze

The tool is unofficial and not affiliated with Waze or Google. Waze has no data API for individuals; the Waze for
Cities feed is for partners only. The live map's own API (`/live-map/api/*`) needs a reCAPTCHA Enterprise token in
`X-Recaptcha-Token` on every call since about April 2026, so plain HTTP clients get 403. This tool opens one
background tab on `https://www.waze.com/cs/live-map/` in your Brave over CDP (port 9222, `--port` to change), mints
tokens with the page's own `grecaptcha.enterprise`, and runs each request inside that tab. It never touches another
tab, and your focused tab stays in front.

The tool closes its own tab when it exits. `--keep-tab` keeps the tab and records its id in
`~/.genesis-tools/waze/tab.json`, and the next run on the same port reuses it. A later run without `--keep-tab` also
reuses the kept tab, and then closes it.

Start Brave with remote debugging with `tools chrome-devtools restart --browser brave --port 9222`. That command quits
and relaunches the browser; session restore usually brings the tabs back.

- **Reports and jams**: `georss`. One answer holds at most 200 alerts and 200 jams, and a capped answer is filled
  with road closures first, so a capped tile is split into four (three levels deep) and results are deduplicated.
  Reports of the same type and subtype at the same spot (to about a metre) are merged into one, shown as `×2` or
  `×3`. A trip's corridor is cut into tiles of about 30 km of route each; a report counts when it lies within
  `--corridor` metres (default 150) of the route line.
- **Routes**: Waze's planner (`user-drive`). Waze avoids vignette motorways unless asked; the tool asks for every
  vignette by default (one fastest route), `--no-vignette` gives the no-vignette routes, `--alternatives` lists both.
  When Waze routing fails, the public OSRM demo server (`router.project-osrm.org`) draws the route instead, labelled
  `osrm`, with no traffic and no departure times. The output says why Waze failed.
- **Places**: Waze's own search through the tab (the destination is searched near the start), then OpenStreetMap
  Nominatim, which gets only the query text. `lat,lon` is used as given.
- **Regions**: Waze serves North America, Israel and the rest of the world from separate environments. The tool picks
  one from the coordinates; there is no flag for it.

### Limits

Measured 2026-11-01:

- One token serves five requests: the sixth answers 429, whether the requests came 0.3 s or 2.5 s apart. So the tool
  mints a new token every five requests, and it reuses a token for at most 90 s.
- After a few hundred requests in a short time Waze refuses every token (403) for the whole IP address, once for six
  minutes and once for more than an hour, which also blocks your own live map. In another run, after about 150
  requests in 15 minutes, every token in a fresh tab got 403 for a few minutes, while a tab open for longer got
  through on its second token.
- The tool spaces requests at least 150 ms apart, two at a time. On a 403 it waits 3 s, then 8 s. On a 429 it waits
  2, 5, 10 and 20 s. A `Retry-After` of more than 20 s fails the request at once.
- One feed sends at most 60 requests, retries included. A tile that fails or is never asked is reported as missing
  area, never silently dropped. A Praha to Brno corridor costs about ten requests.

Every report list states its coverage in its header, for example `12 georss requests, 9 tiles, 1 still capped at 200
(may miss reports), 2 not asked, request budget spent (area missing)`.

### User reports are hidden

The live map's page config sets `hideUserReportsAndWazers: true`, and georss then answers road closures only: no
police, accidents or hazards anywhere (checked in Prague, London, Berlin and along the D1). The tool reads that flag
from the page and prints a warning with every report list (`alerts`, `police`, `route`, `near`, `record`, `watch`,
and the export warnings). `doctor` shows it as the "user reports" check. Closures, jams, routes, ETAs and departure
times are unaffected. If Waze turns the flag off, police reports come back without a code change.

### Side of the road

The side is a hint: Waze snaps a report to the carriageway it was reported on, so on a motorway the left or right
offset says which direction it belongs to (right is your direction in right-hand traffic). The "off route" column
shows the distance from the route line and the side.

### What it needs and what it costs

- Brave (or another Chromium browser) with remote debugging on `127.0.0.1`, port 9222 by default.
- Network access to `waze.com`. It also reaches `nominatim.openstreetmap.org` for a place name that Waze does not find
  and for `link --from` and `open --from`, and `router.project-osrm.org` when Waze routing fails.
- macOS notifications for `watch`.
- Nothing costs money. The only cost is the Waze rate limit above, which your own live map shares.

## Files and configuration

| Path | What it holds |
|---|---|
| `~/.genesis-tools/waze/waze.db` | SQLite history of snapshots and distinct reports |
| `~/.genesis-tools/waze/tab.json` | The kept tab's id and port, written by `--keep-tab` |

The first `record` creates the database. There is no config file and no account. When `GENESIS_TOOLS_HOME` is set,
it takes the place of your home folder in these paths (`$GENESIS_TOOLS_HOME/.genesis-tools/waze/`).

## For agents

- `--json` prints the result data: an object per command, and one per poll for `watch`. When Waze hides user
  reports, a report result carries a `notice` field. `export --json` carries `content`, `complete` and `warnings`.
- Three commands differ. `doctor --json` prints an array of checks (`name`, `status`, `detail`, and `fix` when a
  check has one). `open` has no JSON output: it prints the bare URL. `export -o <file>` writes the document and
  prints no JSON.
- Exit codes: 0 on success. 1 when a command fails (no browser, no route, no place, a Waze error), when `doctor` has a
  failed check, when `--type`, `--format` or `--category` gets an unknown value or is bare without a terminal, and
  when `jams` or `record` gets neither an area nor both `--from` and `--to`. 130 when Ctrl-C stops a command, which
  is how `watch` stops without `--count`.
- `tools waze mcp` serves 15 tools: `alerts`, `police`, `route`, `jams`, `near`, `depart`, `export`, `venues`,
  `venue`, `geocode`, `link`, `record`, `history`, `hotspots` and `doctor`. `watch` and `open` are CLI only. Each
  tool returns Markdown text, and the `--json` data as `structuredContent.result`. Only `record` writes, so it is the
  one tool not marked read-only. The MCP `jams` tool also takes `vignette`.
- The server opens the tab on the first Waze call and closes it when the client closes stdin or sends SIGTERM. Global
  options go before `mcp`: `tools waze --port 9223 --keep-tab mcp`.
- Add the server to a client:

  ```bash
  tools mcp-manager install waze "tools waze mcp" -t stdio -p claude
  ```

- The genesis-tools MCP serves the same tools as `waze_*` when `GENESIS_TOOLS_MCP_CAPABILITIES` names `waze`. It is
  opt-in and never loads for an unset list, because it drives your real browser.

## Troubleshooting

- **"No browser answers CDP on 127.0.0.1:9222".** Brave runs without remote debugging, or on another port. Run
  `tools chrome-devtools restart --browser brave --port 9222`, or pass `--port`.
- **"The Waze live map did not load its reCAPTCHA script within 30 s".** The page is stuck, often on a consent
  screen. Open `https://www.waze.com/cs/live-map/` in the browser once and accept any consent.
- **"Waze answered HTTP 403 ... Waze refused the reCAPTCHA token".** Too many requests in a short time: Waze refuses
  every token for your IP address. Wait a few minutes, then retry. `--keep-tab` reuses one tab, which recovers
  sooner than a fresh one.
- **"Waze answered HTTP 429 ... rate-limited this tab".** Wait a minute and retry.
- **Police, accident and hazard lists are empty.** Waze hides user reports (`doctor` warns on "user reports").
  Nothing to fix: closures, jams and routes still work.
- **"still capped at 200 (may miss reports)" or "not asked, request budget spent".** The area or trip needs more
  tiles than one answer or one feed allows. Use a smaller `--radius`, a smaller box, or a shorter trip.
- **The route says `osrm` and "Waze routing failed".** Waze's planner refused the trip. The corridor follows the OSRM
  route, there is no traffic, and `depart` has no times.
- **"No location found for ...".** Neither Waze nor OpenStreetMap knows the name. Give a fuller address or
  `"lat,lon"`.
- **"Google place ids have no Waze venue card".** `venue` got a `googlePlaces.…` id. Use a `venues.…` id from
  `venues`.
- **"No recorded police reports yet".** `hotspots` has no history for that category. Run `record` first, and see the
  hidden reports above.
- **"--interval must be at least 30s".** Give `watch` an interval of `30s` or more.
- **The kept tab is gone.** A run without `--keep-tab` reused the kept tab and closed it. Pass `--keep-tab` on every
  run that should keep it.
- **`watch --say` shows the notification but speaks nothing.** The notification helper speaks only through a speaker
  that its caller passes, and `watch` passes none. This is a known defect; rely on the notification.

## Related

- [`tools chrome-devtools`](../chrome-devtools/README.md): starts Brave with remote debugging.
- [`tools mcp-manager`](../mcp-manager/README.md): adds `tools waze mcp` to an MCP client.
- [genesis-tools-mcp](../genesis-tools-mcp/README.md): serves the same tools as `waze_*` on request.
- [`tools notify`](../notify/README.md) and [`tools say`](../say/README.md): notifications and speech.
- [`tools hub`](../hub/README.md): its morning brief runs `tools waze --json depart` for the commute.
