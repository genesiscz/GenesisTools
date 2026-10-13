# From a minified position to a source line: `tools ts sourcemaps`

Read this when you hold a position in DEPLOYED JavaScript (a LoAF `sourceURL` + `sourceCharPosition`, a
stack frame `url:line:col`, a `perf load` hint) and need the source line, especially when the deployment
publishes no `.map` files. It covers every strategy the tool has, what each costs, how often it is right,
and the order that gets an answer fastest.

GenesisTools knows nothing about the project. The caller supplies the deployed base URL, the git checkout,
THEIR build command, the build output folder, the env the build needs, and any untracked file to link
(`--link .npmrc`). Never guess these; read them from the project's package.json, CI config or README.

## 1. The fast path (do it in this order)

| Step | Command | Cost | Stop here when |
|---|---|---|---|
| 0 | `fetch <base>` | seconds | it reports published maps: every `resolve` is then `exact` |
| 1 | `resolve … --maps-dir <dir>` or `--sentry-mcp <server>` | one lookup per chunk | a debug-id source has the map: `exact` |
| 2 | `env <base>` | under 1 s | always do it before the first build: it prints the `--env` flags the deployment was built with |
| 3a | known commit: `resolve … --repo . --commit <sha> --build-cmd … --output …` | one build (2-35 s) | `aligned` answers; run `check` once to see how far to trust them |
| 3b | unknown commit: `find-commit --range A..B …` | 1-2 builds + about 10 s of ranking | it prints `best:` with `verified` or `ranked` |
| 4 | `resolve … --build <dir> --build-commit <built> --deployed-commit <deployed>` | ms per position | lines are moved to the deployed commit's version of the file |
| 5 | `check …` | under 1 s | you know this pair's real hit rate |
| 6 | `carry … --out <dir>` then `chrome-devtools intercept --map-dir <dir>` | about 1.5 s | DevTools shows the original sources in the deployed page |

Every step reuses the cache in `~/.genesis-tools/ts/sourcemaps/<project>/`: a deployment snapshot is keyed
by its file list, a build by commit + command + output folder. A second run of any step is near free. Pass
the same `--project` every time.

## 2. The strategies

### Published maps (`deployed-map` resolver, confidence `exact`)

`fetch` downloads every JS/CSS file and follows each `sourceMappingURL`, so you learn in one pass which
files have maps (for example `published maps: 312 fetched · 12 missing`). Exact and instant. Most production sites do
not publish maps, which is why everything below exists.

### Debug IDs (`debug-id` resolver, confidence `exact`, optional)

A bundle built with a debug-id plugin (Sentry's bundler plugins, or any tool following the ECMA-426
`//# debugId=` comment) names the exact map it belongs to. The tool reads the id from the comment or the
`sentry-dbid-<uuid>` literal and asks, in order:

1. maps it kept from an earlier run (`<project>/debug-id-maps/`),
2. `--maps-dir <dir>`: maps you got any other way (Sentry UI, sentry-cli, a CI artifact). It finds files named
   `<id>.map`, maps whose JSON has `debug_id`, and Sentry artifact bundles (`.zip`) as they are,
3. Sentry's artifact lookup (`GET /api/0/projects/<org>/<project>/artifact-lookup/?debug_id=<uuid>`):
   - `--sentry <url> --sentry-org <slug> --sentry-project <slug>` with the token from stdin
     (`--sentry-token-stdin`) or `SENTRY_AUTH_TOKEN`; `--sentry-ca <pem>` for a private CA.
   - `--sentry-mcp <server>` takes the URL, token and CA from a Claude Code MCP server entry
     (`~/.claude.json` project or user scope, or `.mcp.json`), so an agent never handles the token.
   - Without `--sentry-org` or `--sentry-project` it lists what the token can see, so the second call is right.

| Pro | Con |
|---|---|
| exact, no build at all | only if the build injected debug ids AND uploaded maps |
| one download per bundle, then cached forever | Sentry refuses the download (403) unless the token's user has an org role at or above the project's "debug files" role (default admin), or the token is a team admin token with `project:write`. The lookup itself works with `project:read`, so a 403 on the DOWNLOAD means "the map exists, ask for the role" |
| | Sentry rate-limits downloads per bundle; the kept copy avoids a second one |

Self-hosted Sentry behind a proxy builds download links from its internal host name; the tool keeps the
path and query and uses the host you reached. A private CA bundle that stops at an intermediate is
completed from the macOS keychain (Bun's TLS needs the root; curl does not). Never use the Sentry release
name or `SENTRY_RELEASE` to pick a commit: it is a label, not evidence.

### A local build (`local-build` resolver, confidence `aligned` or `approximate`)

Build the code yourself, then carry each position from the deployed chunk to the local one: identifiers
are collapsed in both (mangled names differ between builds), a code window around the position must occur
exactly once in the local chunk, the local map answers, and the code 300 characters before and after must
agree within 25%. One uniquely matching window is `aligned`; the nearest of several is `approximate`.

Chunks pair by their stable part of the name, so this works across bundlers: webpack/rspack/rsbuild
`710.f9e49e56.chunk.js` or `710.f9e49e56.js`, Vite/Rollup `index-BSUOir56.js`. When many chunks share one
name once the hash is gone (esbuild and Angular emit `chunk-K3J2Q1ZA.js` for every shared chunk), they pair
by content instead: the local file that shares the most strings and property names, at least half of them.

Measured with a second build standing in for the deployment, its own maps as the truth (about 8,700
positions per run, about 3 s per run):

| Deployment stand-in and local build | Right line |
|---|---|
| rsbuild, local builds of two other commits | 98.6% and 99.5% |
| webpack, local build of a nearby commit | 99.4% |
| webpack, local build of an older commit | 96.2% of all answers, 99.5% of the `aligned` ones |
| Vite, local build 3 commits off, without and with `--deployed-commit` | 80% of `aligned`, then 100% |

Without `--deployed-commit` the line numbers are the BUILD's, off by whatever changed above them. With it,
lines move through the `git diff` hunks between the two commits, and a line inside a changed hunk is
marked changed and never called `aligned`.

Pass `--build-commit` when `--build <dir>` is a folder you built yourself, so translation knows its commit.

### Finding the deployed commit: `find-commit`

Use it when nobody can tell you which commit is deployed. Two strategies:

- `tokens` (default): ONE reference build (default: the end of the range). For every first-parent commit
  in the range, the tool predicts the deployed bundle's string and property-name counts from the reference
  build plus the commit's source changes (no build per commit), and ranks commits by how close the
  prediction lands. Commits that produce the same strings tie; the answer is the OLDEST commit of the tie,
  because that commit introduced the deployed code. One more build of that commit confirms it (`verified`);
  `--no-verify` skips it (`ranked`). Measured: 7 commits in 6-7 s, 40 in about 10 s, 631 in 12 s, plus
  the builds. The deployed commit was in the winning tie in all 4 trials (webpack and Vite).
- `rebuild`: builds the commits that touched the files where the deployment differs from the reference
  build, up to `--max-builds`. Slower (one build each), useful when the token ranking is flat.

Evidence it also prints, never as the answer on its own:

- commit shas the bundle names (`REACT_APP_BUILD_INFO`-style objects): "the code evidence agrees" or
  "points elsewhere; trust the code",
- the newest `Last-Modified` of the deployed JS (when the server sends one): commits after it cannot be
  the build, and a best commit after it is flagged,
- env values the bundle inlined that your build did not get the same (see `env`).

Narrow `--range` as far as you honestly can (the last known-good release tag to the branch head); the
default first-parent walk ignores merged branch commits (`--all-parents` includes them).

### The env a deployment was built with: `env`

Bundlers inline `process.env` (webpack, CRA, rsbuild) and `import.meta.env` (Vite) as object literals.
`env <base>` reads them and prints ready `--env NAME=VALUE` flags. A build without the same values differs
in strings and, worse, in code the bundler removed as dead (`if (process.env.X === "true")`). Values a
`define` replaced one by one have lost their names and cannot be recovered.

`--deployed-env` on `resolve`, `check`, `carry`, `rank` and `find-commit` passes those values to the build
directly, so the long JSON values never go through a shell; an explicit `--env` wins over a deployed one.
It only adds what the deployment inlined: a variable the build script itself needs (`NODE_ENV=production`
for a CRA `build-ci`) still belongs in `--build-cmd`. Apps that read their config at runtime (Angular
`environment.ts`, a runtime `window.__ENV__`) inline no env object, and `env` says so.

### How right is `resolve` on THIS deployment: `check`

No map gives the truth for a map-less deployment, but its string literals do: they survive minification
verbatim. `check` samples unique literals (12+ characters) per deployed file, resolves each position with
the same chain `resolve` uses, and counts how often the literal sits within 3 lines of the answer, per
confidence word. Measured on a 330-chunk webpack app: 95.4% `near` for `aligned`, 0.2-0.7 s for 150-400
literals. Read the result as an upper bound (code with strings is easier than code without). Known false
misses: compiler-made literals (`react.memo_cache_sentinel`) and constants built from templates. When
positions stay unresolved, `check` prints the three most common reasons (a failed build, a chunk with no
counterpart, a map with no segment there).

Measured 2026-10-12 on three more apps:

| App, bundler | Build | Unresolved | `near` for `aligned` |
|---|---|---|---|
| CRA webpack, 313 chunks | the commit `find-commit` named | 4 chunks only the deployment has | (`carry`: 111 of 123 live scripts got a map) |
| Angular 21 (esbuild), 365 files | the deployed commit, `--sourceMap=true` | 0.4% | 64.4% |
| Vite dashboard, 67 files | HEAD | 18.8% (vendor code the map leaves unmapped) | 97.7% |

The Angular misses are compiler-made code: a component's `selectors` and host bindings map to the class,
not to the decorator line that holds the literal, so `check` undercounts there. Before content pairing the
same Angular check was 100% unresolved.

### Real maps for DevTools: `carry` + `intercept --map-dir`

`carry` writes one map per deployed chunk: both chunks are diffed with identifiers collapsed (unique
32-character anchors, longest increasing chain, grown in both directions), and every local mapping inside
an equal stretch is moved to the same code in the deployed chunk. Mappings in code that differs are
dropped, never guessed. Measured: webpack and rsbuild 100% right line on 12,000+ probes, about 1.4 s for
350 chunks; Vite with a build 3 commits off 90%; a wrongly paired control 15%. The maps name the LOCAL
build's lines: build the deployed commit for line-exact results.

Then, in the tab with the deployed app:

```bash
tools chrome-devtools intercept --match app.example.com --map-dir ./carried-maps
# reload the tab: each deployed script gets its carried map inline; open Sources
```

Measured: 138 of 144 scripts parsed with the carried map after one reload (the rest had no local
counterpart). The interception lives only as long as the command.

### Deployments without a manifest

Discovery reads, in order: a build manifest (`asset-manifest.json`, `.vite/manifest.json`,
`manifest.json`), else the page's script and preload tags, the bundler runtime's chunk table
(webpack/rspack chunk-name functions are evaluated for every chunk id; nothing else runs), ES `import`s
and Vite's preload list, followed transitively, plus `remoteEntry.js` (module federation). Measured: every
file the page can load (327 of 330 on webpack, 357 of 360 on rsbuild; the misses were scripts no page
loads) in about 1.7 s. `--page <url>` starts from another page; `--asset <url>` adds a file and follows its
references. A downloaded artifact on disk needs no fetching: `--deployed-dir <dir>`.

## 3. Examples

```bash
# Maps are published: one fetch, then exact answers.
tools ts sourcemaps fetch https://app.example.com/
tools ts sourcemaps resolve https://app.example.com/static/js/710.f9e49e56.chunk.js:95812

# Debug ids, map from Sentry through a configured MCP server (the token never leaves its config).
tools ts sourcemaps resolve <url>:<offset> --deployed https://app.example.com/ \
    --sentry-mcp sentry-prod --sentry-org acme --sentry-project web

# Known commit: build it with the project's own command and env.
tools ts sourcemaps env https://app.example.com/            # see what the deployment inlined
tools ts sourcemaps resolve <url>:<offset> --deployed https://app.example.com/ \
    --repo . --commit v1.4.2 --output web/build --link .npmrc \
    --build-cmd 'bun install --frozen-lockfile && bun run build' --deployed-env

# Unknown commit: rank the range with one build, then resolve with line translation.
tools ts sourcemaps find-commit --deployed https://app.example.com/ --repo . --range v1.4.0..origin/main \
    --build-cmd 'bun install --frozen-lockfile && bun run build' --output web/build --link .npmrc
tools ts sourcemaps resolve <url>:<offset> --deployed https://app.example.com/ --repo . \
    --build ~/.genesis-tools/ts/sourcemaps/<project>/build-<sha>-<hash>/files \
    --build-commit <built sha> --deployed-commit <best sha>

# Calibrate once per deployment and build, then browse with real sources.
tools ts sourcemaps check --deployed https://app.example.com/ --build ./web/build --files 40
tools ts sourcemaps carry --deployed https://app.example.com/ --build ./web/build --out ./carried-maps
tools chrome-devtools intercept --match app.example.com --map-dir ./carried-maps
```

`resolve` exits 1 when any position stays unresolved; `--json` on every verb gives the machine result.

## 4. Efficiency rules

- Never build commit by commit. `find-commit --strategy tokens` ranks hundreds of commits from ONE build.
- Run `env` before the first build. A build with the wrong env wastes its whole build time.
- Keep one `--project` name per app; every reuse depends on it.
- Use `--deployed-dir` for an artifact you already have; use `--files N` on `check` for a quick read.
- Resolve many positions in one `resolve` call: the snapshot, maps and normalized chunks load once.
- `PROFILE=sourcemaps` prints each phase (discover, snapshot, build, hints, tokens.rank, find-commit,
  calibrate, carry, debug-id.sentry.*). `tools config profiling --enable --scopes sourcemaps --detail all`
  adds one timer per position and per resolver.

## 5. Traps

- An error-monitor snippet injected before minification renames every identifier; that is why matching
  collapses identifiers and never compares raw text.
- A commit sha inside the bundle is a hint. Builds can carry a stale or foreign sha; the code decides.
- Servers that send no `Last-Modified` (common behind a CDN) give no time bound; the tool says nothing then.
- An SPA fallback answers every unknown path with HTML, including manifest names; discovery treats a
  non-JSON manifest as missing and crawls instead.
- `check` and `carry` grade code that is in BOTH builds. A chunk that only the deployment has stays
  unresolved: report it as such, never guess a nearby file.
