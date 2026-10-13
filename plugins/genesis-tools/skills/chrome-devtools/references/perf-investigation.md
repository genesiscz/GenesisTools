# Front-end performance and app-state investigation

For a slow or stuck UI, a blocked main thread, a slow interaction, an A/B of two builds or settings,
a look into IndexedDB / Web Storage / React state, or "which source line is this minified position".
Everything here runs through `tools chrome-devtools` and `tools ts sourcemaps`; no
chrome-devtools-mcp is needed.

Contents: 1 Setup · 2 Why observers, not a trace · 3 Measure a load · 4 Interactions ·
5 A/B · 6 Hold an override · 7 Storage · 8 React state · 9 SPA steps · 10 Source positions ·
11 Custom flows · 12 Traps

## 1. Setup

Use a browser you may throttle and reload: `tools chrome-devtools open --browser chrome --port 9223 --fresh`
(throwaway profile) or `--user-data-dir <dir>` (logins survive). Logging in is the caller's job.
With several live ports, `--match <url-substr>` picks the port whose tab matches; `--port` still wins.

## 2. Why in-page observers, not a DevTools trace

A full DevTools trace at 6x CPU distorts the thing it measures (one real investigation got a single
7.8 s task and a 266 MB file). The `perf` verbs install `PerformanceObserver`s as an init script
(before the page's own scripts): long-animation-frame with script attribution (invoker, invoker type,
source URL, function, char position, forced layout), longtask, layout-shift with source nodes, event
timing (INP), a 50 ms lag sampler, and caller-defined marks. Cheap enough to run at 6x.

## 3. Measure a load: `perf load`

```bash
tools chrome-devtools perf load https://app.example.com/dashboard --runs 3 --cpu 6 \
    --mark 'ready=[data-testid=main]@Welcome' --until '[data-testid=main]' -o load.json
```

Read, in order: blocking total, the `byInvoker` groups (`Response.json.then`, `TimerHandler:setTimeout`,
`event-listener:onclick`, `classic-script`, `rendering`), the worst frames with their script location
(`/static/js/710.f9e49e56.chunk.js:95812 fn`), CLS (session window), max lag, marks (ms since the
navigation, 50 ms resolution). `--network slow-4g|fast-4g|3g|offline` adds network presets.
`--runs > 1` prints p50/p90/min/max. One run is an observation, not a result.
The last line names the source-map lookup for the worst frame, with the full script URL
(`which source line: tools ts sourcemaps resolve <url>:<offset>`); section 10 explains it.

## 4. Interactions: `perf record` and the `interaction` recipe

`perf record --seconds 20 --cpu 4` observes the CURRENT document while a person clicks: INP and the
slowest events (input delay, processing, target). For a repeatable "click, then time until X shows":
`tools chrome-devtools scaffold clickTiming --recipe interaction`, then
`tools scripts run clickTiming -- --port 9223 --match app.example.com --click 'button[aria-label=Menu]' --until '[role=menu]' --rates 1,4,6`.
It clicks with a real (trusted) mouse event; work triggered through `eval` never shows up as a LoAF.

## 5. A/B: `perf ab <spec.json>`

Interleaved ABBA rounds, per-variant distributions, every sample saved after every run (`-o`).

```json
{
  "url": "https://app.example.com/dashboard",
  "rounds": 3, "cpu": 6, "waitMs": 20000,
  "clearStorage": { "sessionStorage": ["someReplaySession"] },
  "marks": [{ "name": "ready", "selector": "[data-testid=main]" }],
  "variants": [
    { "name": "flag-on" },
    { "name": "flag-off", "rewrite": [{ "url": "*/config.js*", "replace": [{ "from": "FLAG:\\s*\"[^\"]*\"", "to": "FLAG: \"false\"" }] }] }
  ]
}
```

- State that survives reloads (a sampling decision in sessionStorage, a cached flag) leaks between
  variants: name it in `clearStorage` / `clearCookies`, it is cleared before the app runs each time.
- A library bundled into the app's chunks cannot be found by `sourceURL`; the difference between
  variants IS the attribution. Never conclude from one sample per variant.

## 6. Hold an override: `emulate`, `intercept`

CPU/network overrides, init scripts and request interception belong to the CDP session and end when
it disconnects, so these verbs HOLD the connection until Ctrl-C or `--seconds`, then restore.

```bash
tools chrome-devtools emulate --match app.example.com --cpu 4 --network slow-4g
tools chrome-devtools intercept --match app.example.com --url '*/config.js*' --replace 'FLAG: "true"=>FLAG: "false"'
```

`intercept` also takes `--body-file <file>` or `--block`; rewritten responses get `cache-control: no-store`.

## 7. Storage: `storage idb`, `storage web`

`storage idb --match app.example.com [--db x --store y --key k] [-o dump.json]` dumps the origin's
IndexedDB read-only (a missing database is reported, never created; strings stay byte-exact; no value
cap unless `--max-value-bytes`). `storage web` does localStorage + sessionStorage.

A browser started WITHOUT a debug port (the user's own, which must not be restarted):
`storage idb --from-profile "~/Library/Application Support/BraveSoftware/Brave-Browser/Default" --origin https://app.example.com --browser brave`
copies that origin's IndexedDB folders into a scratch profile, opens it headless, answers every
request to the origin with a blank page (no app code, no network) and dumps it.

🛑 The leveldb folder size on disk is NOT the data size, in either direction (measured: 2.4 MB folder
for 370 KB of rows; 19.7 KB folder for 360 KB). Quote the JSON bytes column, never `du`.

## 8. React state without a global: `react find`

```bash
tools chrome-devtools react find --match app.example.com --function client.getQueryCache --function store.getState
tools chrome-devtools react find --match app.example.com --function client.getQueryCache --expose __qc
tools chrome-devtools eval --match app.example.com '() => window.__qc.getQueryCache().getAll().length'
```

Structured matchers walk every React root (no eval in the page, works under a strict CSP). The walk
starts from the FiberRoot's current tree (`stateNode.current`); the container key alone can point at a
stale alternate and see one fiber. Library-specific probes live in `@genesiscz/utils/chrome-devtools/libraries/<lib>/`.

## 9. In-app steps without reloads: `nav --spa`

`nav /billing --spa --match app.example.com --wait-for '[data-testid=billing]'` does
`history.pushState` + `popstate`, so caches and app state survive. For a measured walk over many
routes, scaffold `--recipe spa-steps` (each step reads only its own frames: `collectPerf({ since, drain })`).

## 10. Which source line is a minified position: `tools ts sourcemaps`

A LoAF line gives `sourceURL` + `sourceCharPosition`; a stack frame gives `line:column`.

```bash
tools ts sourcemaps resolve https://app.example.com/static/js/710.f9e49e56.chunk.js:95812 \
    --deployed https://app.example.com/ --build ./web/build
tools ts sourcemaps find-commit --deployed https://app.example.com/ --repo . --range v1.2.0..origin/main \
    --build-cmd 'bun install --frozen-lockfile && bun run build' --output web/build --link .npmrc
```

Resolvers in order: the deployment's own `.map` (exact; `fetch` preflights them all), a map found by
debug id (a maps folder or Sentry's artifact lookup, optional), then a local build (identifiers
collapsed, a unique code window carries the offset). `find-commit` ranks every commit of a range from
ONE build by the strings each would put in the bundle, then confirms the best one with a second build.
The build command, env and output folder are the CALLER's; GenesisTools knows nothing about the
project. Read `references/sourcemaps.md` before the first build: it gives the fastest order, every
strategy's cost and measured hit rate, `check` (calibration on the deployment itself) and `carry`
(real maps for DevTools).

## 11. Custom flows: scaffold recipes and the library

`tools chrome-devtools scaffold <name> --recipe perf-load|perf-ab|spa-steps|interaction|idb-dump`
writes an editable script into the `tools scripts` store; run it with `tools scripts run <name> -- --port <p> --match <m> ...`.
The scripts import `@gt/utils/chrome-devtools/*`, the same library the verbs use:
`perf.ts` (installPerf, measureLoad, collectPerf, resetPerfMarks), `emulate.ts`, `intercept.ts`,
`ab.ts` (runAb), `storage.ts`, `spa.ts`, `summaries.ts`, `libraries/react/`. Every helper takes a
`CdpLike` (`send`/`on`/`off`), so a playwright `CDPSession` works too; in-page functions are
self-contained (`fn.toString()` travels to the page).

## 12. Traps

- A hidden (background) tab throttles timers and skips frames: its numbers are invalid. `perf load`
  brings the tab to the front; every summary warns when the page was hidden.
- Overrides and init scripts end when the CDP session ends (the reason `emulate`/`intercept` hold).
- Work started from a CDP `Runtime.evaluate` body produces no LoAF entry; trigger it from page code.
- Marks are checked every 50 ms and once more when a snapshot is taken.
- A local rebuild never matches a deployed chunk byte for byte (an injected monitoring banner renames
  every identifier; build-time env values are inlined), and module ids can move. Align, never compare
  hashes.
- `NODE_ENV=development` in the shell breaks some production builds; the build command must set it.
