# node-repl

A persistent JavaScript/TypeScript REPL for agents, exposed as an MCP stdio server. It is a
GenesisTools-native equivalent of Codex's `node_repl`: the same four tool names, no Codex, no
OpenAI runtime.

```bash
tools node-repl mcp                     # MCP stdio server
tools node-repl mcp --toolset computer  # the same, with the computer global preloaded
tools node-repl run 'const a = 1; a+1'  # one turn from the shell
echo 'await import("node:os")' | tools node-repl run
```

## Toolsets

`--toolset a,b` (on `mcp` and `run`) preloads APIs from the `REPL_TOOLSETS` table in `lib/toolsets.ts`:
`computer` (native Computer Use), `recorder` (start, attach to and control screen recordings over the live
recording socket: pause, resume, stop after post-processing, set, displays.*, audio.*, on, waitFor) and `editor`
(open a recording id or a video, then frames, change-only frames, grids with `.show()`, trim, speed, export, each a
job with progress). A toolset is a `ReplToolset` subclass (`@genesiscz/utils/repl/toolset`) with an
`ApiDescriptor` (`@genesiscz/utils/api-descriptor`: per method a name, zod params and result, one line and an
effect of `read`, `reversible` or `destructive`). The kernel builds the toolsets once per worker with a `preload`
request that has its own budget (120 s), not the turn's; after a timeout kill or `js_reset` the new worker
preloads them again, and reset, exit and the end of a `run` dispose them. Each worker gets a private scratch
folder for its toolsets, removed when the worker stops.

`movies` (`src/recorder/lib/toolset.ts`) records the screen as a movie (`record` returns a handle with status, pause,
resume and stop) and edits a recording's `edit.json`: `open(id)` returns a Movie with split, cut, keep, speed, zoom,
autoZoom, volume, mute, apply, undo, export and show. Its times are source seconds, and the open recorder window takes
each save as it lands. The CLI door to the same edits is `tools recorder project` and `tools recorder apply`.

The registry also includes `meetings` (open, evidence, transcript, items.add; how a meeting finds its project:
`projects.labels`, `projects.pair`, `projects.unpair`, `projects.people`, `assign.sweep`, and on a meeting
`assign.proposals`, `assign.ask`, `assign.apply` and `set({ labels })`), `control` (the native control API),
`browser` (CDP tabs, open, navigate, evaluate), `hub` (prs, pr), `github` (review threads) and `presets` (save,
list, show, run and remove named scripts with parameters; see "Presets").
Each lives in one toolset file and has one registry entry. Browser calls take the browser's CDP `port` explicitly.

The `js` description gives one summary line per loaded toolset. Inside a turn, `search("display")` finds methods
by name, description, and parameter schema; `describe("recorder.start")` prints the full method descriptor.
`describe()` accepts both the qualified handle names from search, such as `recorder.Recording.displays.switch`,
and the names from help, such as `recording.displays.switch`.
`help()` lists toolsets and `help("computer")` prints the full API with every signature; `await show(x)` returns
an image to the model (a path, a Buffer or Uint8Array, `{ path }` or `{ bytes, mimeType }`, or an array of them).
Recordings started in a turn belong to the parent engine. A turn timeout loses bindings but leaves those
recordings running: use `await recorder.list()` and `await recorder.attach(id)` in the next turn.
`js_reset`, normal server shutdown, and the end of `run` stop owned recordings and await their post-processing.
Library recordings use the same Vision OCR function as meetings when OCR is enabled, writing a JSON sidecar
beside each kept frame whose text meets `minChars`.
`await sleep(ms)` waits inside a turn. The whole recorder and editor flow, live:
`bun src/node-repl/scripts/recorder-editor-demo.ts --out <folder> [--mic]`.
For an experiment, an entry may also be `/abs/module.ts#ExportName`, a `ReplToolset` class outside the table.

## Presets: save a script that worked, run it again with other values

The `presets` toolset (and `tools node-repl preset`) keeps REPL scripts under a name with parameters, the way `tools
scripts` keeps scripts: one folder per preset in `~/.genesis-tools/node-repl/presets/<name>/`, the code in
`script.js` (edit it there) beside `preset.json` (description, toolsets, params, run count), and a removed preset moved
to `.trash/`. A script is the body of an async function: it reads `params` and returns its result.

```js
await presets.save("settings-demo", {
    description: "a captioned demo of one Settings pane",
    script: `return await movies.demo({ title: params.title, steps: [
        { caption: "Open " + params.pane, run: () => computer.launch_app({ bundle_id: "com.apple.systempreferences" }) },
    ] });`,
    params: { title: { type: "string", default: "Settings" }, pane: { type: "string" } },
});
await presets.list();                                  // [{ name, toolsets: ["movies", "computer"], params, runs }]
await presets.run("settings-demo", { pane: "Appearance" });
await presets.remove("settings-demo");                 // { trash }
```

`params` types are `string`, `number`, `boolean` and `json`; one without a default is required at every run, and an
unknown name is refused before anything runs. `toolsets` defaults to the toolsets the script names (`movies.`,
`computer.`); a run in the REPL needs them loaded and says which `--toolset` to start with.

```bash
tools node-repl preset save settings-demo --file demo.js --params '{"pane":{"type":"string"}}' [--description T]
tools node-repl preset list [--json]
tools node-repl preset show settings-demo
tools node-repl preset run settings-demo --param pane=Appearance [--timeout 600000]   # a fresh REPL with its toolsets
tools node-repl preset rm settings-demo
```

## Tools

| Tool | What it does |
|---|---|
| `js` | Run JS or TS with top-level `await`. Arguments `{ "code": "...", "timeout_ms": 30000, "title": "..." }`; only `code` is required. The last expression is the result; a string comes back raw, anything else through `Bun.inspect`. |
| `js_add_node_module_dir` | Register an absolute directory whose `node_modules` resolves from `import()` inside the REPL. Argument `{ "path": "/abs/project" }`, the directory that CONTAINS `node_modules`. Survives `js_reset`. |
| `js_reset` | Kill the worker and start a fresh one; every binding is gone, the toolsets are disposed and preloaded again. |
| `turn_ended` | No-op, kept for hosts that send it. |

Inside a turn the global `nodeRepl` offers `write(value)` (append to the turn's text output),
`await emitImage({ bytes, mimeType })` (an MCP image block plus a file under the temp dir, whose
path is also returned as text), `cwd`, `homeDir` and `tmpDir`.

## A call sequence

```jsonc
// 1. keep a binding
js { "code": "let counter = 41;\ncounter" }                       // -> 41
// 2. a later, separate call sees it
js { "code": "counter + 1" }                                       // -> 42
// 3. make a project's node_modules importable
js_add_node_module_dir { "path": "/Users/martin/proj" }            // -> "module directory registered: ..."
js { "code": "const { default: dayjs } = await import('dayjs');\ndayjs().year()" }
// 4. hand back an image: any PNG bytes, from a file or an encoder
js { "code": "await nodeRepl.emitImage({ bytes: await Bun.file('/tmp/chart.png').bytes(), mimeType: 'image/png' });\n'sent'" }
// 5. start over
js_reset {}
```

Step 4 returns an MCP `image` content block followed by a text block naming the file the
bytes were also written to. A turn that overruns `timeout_ms` comes back as an error naming
the limit, and every binding is gone, exactly as after `js_reset`.

## How bindings persist

Each turn runs inside an async IIFE, where `let`, `const`, `class` and `function` would be
local. `lib/rewrite.ts` rewrites the top level of the turn with `oxc-parser`: variables become
bare assignments, classes and functions become `globalThis.Name = …`, and the last expression is
returned. Redeclaring a name overwrites the property, which is what a REPL means by it.
TypeScript is stripped first with `Bun.Transpiler`.

## Why the REPL lives in a child process

`vm`'s own timeout only bounds synchronous code. A turn that loops on `await Promise.resolve()`
starves the event loop with microtasks and defeats every in-process timer, including a
`setTimeout` race in the same process. So the REPL scope is the global scope of
`lib/worker.ts`, a child of the MCP server, and `lib/engine.ts` enforces `timeout_ms` from the
parent by killing and respawning it. A killed turn reports that every binding is gone.
`js_reset` is the same operation on purpose. There is no separate `vm` context: the process is
the sandbox, and a second realm only makes `Bun.inspect` print every object with its prototype.

## Imports

Every `import()` inside a turn passes through one callback, which is the trust chokepoint.
`~/.genesis-tools/node-repl/trust.json` may set `allowBuiltins`, `allowRepoDeps`, `allowPaths`
and `allowBare`; the defaults allow `node:` builtins, absolute paths, the server's own
dependencies and any directory added with `js_add_node_module_dir`. The policy is read when the
worker starts and never changed by a turn.

## Registering it

One command per host, through the repo's MCP manager:

```bash
tools mcp-manager install node-repl "tools node-repl mcp" -p claude -t stdio   # or -p codex, cursor, gemini, all
tools mcp-manager list                                                          # confirm it landed
```

By hand it is the same shape as every other server this repo owns:

```json
{ "command": "/Users/Martin/projects/GenesisTools/tools", "args": ["node-repl", "mcp"] }
```
