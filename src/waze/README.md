# waze

Waze from the terminal and as an MCP server: police and every other report along a whole trip, routes with ETA and
alternatives, jams, the best departure time, exports, a local history with police hotspots, and Waze's official deep
links. Unofficial; not affiliated with Waze or Google.

```bash
tools waze police Praha Brno                     # police on the corridor, km from the start, age, side
tools waze route Praha Brno --alternatives       # ETA, alternatives, every report and jam on the route
tools waze route "50.08,14.43" Plzeň --type police,accident --corridor 300
tools waze depart Praha Brno --at "tomorrow 07:00" --window 3   # best 15-minute departure
tools waze export Praha Brno --format gpx -o trip.gpx           # geojson, gpx, kml, csv
tools waze watch Praha Brno --interval 2m --say  # notify on each new police or accident report
tools waze alerts Praha --radius 3 --type police # reports around a place, nearest first
tools waze alerts "49.9,14.2,50.2,14.7"          # or inside a box: south,west,north,east
tools waze jams Brno --min-level 3               # jams around a place
tools waze jams --from Praha --to Brno           # jams along a trip
tools waze near "Václavské náměstí"              # everything within 2 km
tools waze venues benzina --near Brno            # Waze place search; ids feed `venue`
tools waze venue venues.10879468.108925751.271372
tools waze geocode "Brno hlavní nádraží"         # or "49.19,16.61" for the street address
tools waze link Brno --from Praha                # official waze.com/ul links, no browser tab
tools waze open Brno --from Praha                # opens the live map with the route
tools waze record Praha --radius 15              # snapshot into ~/.genesis-tools/waze/waze.db
tools waze record --from Praha --to Brno
tools waze history
tools waze hotspots --since 30                   # police hotspots by place and hour of day
tools waze doctor                                # read-only: browser, tab, token, one georss call
tools waze --keep-tab police Praha Brno          # leave the tab open: the next run starts faster
tools waze --json route Praha Brno               # machine-readable result
tools waze mcp                                   # stdio MCP server, one tool per command
```

Add the MCP server to a client: `tools mcp-manager install waze "tools waze mcp" -t stdio -p claude`. The
genesis-tools MCP serves the same tools as `waze_*` when `GENESIS_TOOLS_MCP_CAPABILITIES` names `waze` (opt-in).

## How it reaches Waze

Waze has no data API for individuals; the Waze for Cities feed is for partners only. The live map's own API
(`/live-map/api/*`) needs a reCAPTCHA Enterprise token in `X-Recaptcha-Token` on every call since about April 2026,
so plain HTTP clients get 403. This tool opens one background tab on `https://www.waze.com/cs/live-map/` in your
Brave over CDP (port 9222, `--port` to change), mints tokens with the page's own `grecaptcha.enterprise`, and runs
each request inside that tab. It never touches another tab and closes its own tab when it exits (`--keep-tab` keeps
it, and the next run reuses it). Start Brave with remote debugging with
`tools chrome-devtools restart --browser brave --port 9222`.

- **Reports and jams**: `georss`. One answer holds at most 200 alerts and 200 jams, and a capped answer is filled
  with road closures first, so a capped tile is split into four (three levels deep) and results are deduplicated.
  A trip's corridor is cut into tiles along the route; a report counts when it lies within `--corridor` metres
  (default 150) of the route line.
- **Routes**: Waze's planner (`user-drive`). Waze avoids vignette motorways unless asked; the tool asks for every
  vignette by default (one fastest route), `--no-vignette` gives the no-vignette routes, `--alternatives` lists both.
  When Waze routing fails, the public OSRM demo server draws the route instead (labelled `osrm`, no traffic).
- **Places**: Waze's own search through the tab, then OpenStreetMap Nominatim. `lat,lon` is used as given.
- **Limits** (measured 2026-11-01): one token serves five requests (the sixth answers 429), so the tool mints a new
  one every five. After a few hundred requests in a short time Waze refuses every token (403) for the whole IP
  address, once for six minutes and once for more than an hour, which also blocks your own live map. The tool backs
  off, then reports the tile as missing area (never silently dropped), and one feed sends at most 60 requests. A Praha → Brno corridor
  costs about ten requests.
- **User reports are hidden today.** The live map's page config sets `hideUserReportsAndWazers: true`, and georss
  then answers road closures only: no police, accidents or hazards anywhere (checked in Prague, London, Berlin and
  along the D1). The tool reads that flag from the page and prints a warning with every report list; `doctor`
  shows it. Closures, jams, routes, ETAs and departure times are unaffected. If Waze turns the flag off, police
  reports come back without a code change.
- **Side of the road** is a hint: Waze snaps a report to the carriageway it was reported on, so on a motorway the
  left or right offset says which direction it belongs to (right is your direction in right-hand traffic).
