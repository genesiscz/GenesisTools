# tools node-repl

A persistent JavaScript and TypeScript REPL for agents, served as an MCP stdio server and as a one-turn shell
command. Bindings survive between calls, top-level `await` works, images come back as MCP image content, and
`--toolset` preloads GenesisTools APIs (native app control, screen recording, movie editing, meetings, browser tabs,
pull requests) once per worker. It is a GenesisTools-native equivalent of Codex's `node_repl`: the same four tool
names, with no Codex and no OpenAI runtime.

## Quick start

```bash
tools node-repl run '1 + 1'                                          # one turn from the shell: prints 2
echo '(await import("node:os")).cpus().length' | tools node-repl run  # the code on stdin
tools node-repl run --toolset movies "help('movies')"                # one toolset's methods, one line each
tools node-repl run --toolset movies --file edit.js > edit.log 2>&1  # a long script (10 min budget with movies)
tools mcp-manager install node-repl "tools node-repl mcp" -p claude -t stdio   # register the MCP server
tools node-repl preset list                                          # the saved presets; a * marks a required param
```

## Commands

| Command | What it does |
|---|---|
| `mcp` | Start the MCP stdio server (tools `js`, `js_reset`, `js_add_node_module_dir`, `turn_ended`). |
| `run [code]` | Run one turn in a fresh worker and print its output. |
| `preset list` | The saved presets with their params and run counts. |
| `preset show <name>` | One preset's metadata, folder and script. |
| `preset save <name>` | Save a script as a named preset with parameters. |
| `preset run <name>` | Run a preset with other values, in a fresh REPL with the toolsets it needs. |
| `preset rm <name>` | Move a preset to the presets folder's `.trash/`. |

The tool also takes `-v, --verbose` (more logging) and `--readme` (print this page). `tools node-repl --help` ends
with one line per toolset.

### mcp

```bash
tools node-repl mcp                                  # plain JavaScript, no toolsets
tools node-repl mcp --toolset movies,computer,presets
tools node-repl mcp --max-output 0                   # never cut a turn's text
```

| Flag | Default | Meaning |
|---|---|---|
| `--toolset [list]` | none | Comma-separated toolsets to preload ([Toolsets](#toolsets)). |
| `--max-output <chars>` | `20000` | The most characters a turn returns; `0` is no limit. |

Text longer than `--max-output` is cut, with a note that names the file holding all of it and the expression that
reads the next part. 20,000 characters is about 5,000 tokens, so one careless `big.join()` cannot fill an agent's
context (2026-11-06). The server's turn budget is 30000 ms unless a `js` call passes `timeout_ms`; the 10 minute
default of `run` does not apply here. The server stops when stdin ends or on SIGINT or SIGTERM, and it first disposes
the toolsets and finishes the recordings it owns.

### run

```bash
tools node-repl run 'const a = 1; a + 1'
tools node-repl run --file script.ts --timeout 120000
tools node-repl run --toolset computer --file steps.js
```

| Flag | Default | Meaning |
|---|---|---|
| `--file <path>` | | Read the code from a file. |
| `--timeout <ms>` | `30000` | Wall-clock budget; `600000` with the `movies`, `recorder` or `editor` toolset. |
| `--toolset [list]` | none | Comma-separated toolsets to preload. |
| `--max-output <chars>` | `20000` | As for `mcp`. |

- The code comes from the argument, from `--file`, or from stdin. An argument together with `--file` is refused.
  A terminal on stdin is refused at once instead of waiting for Ctrl-D, and an empty file or empty stdin is refused.
- `--timeout` is in milliseconds. A value under 1000 still runs, with a warning: `--timeout 120` is 0.12 s, and
  `--timeout 120000` is two minutes.
- `console.log` and `nodeRepl.write` lines print as the turn writes them, up to `--max-output`. The result prints
  when the turn ends. Streaming stops for good at the first line past the limit, so no line prints twice.
- Each image the turn returns is written to a file, and a log line names the file.
- Each `run` is a fresh process, so bindings do not survive between `run` calls. The `mcp` server keeps them.
- The exit code is 1 for a failed turn, a timeout, or a bad flag; the error goes to stderr.
- For a long run, redirect the output to a file and read the file. Do not pipe it into `head` or `tail`.

`tools node-repl run --help` lists the helpers you can call inside a turn ([Inside a turn](#inside-a-turn)).

### preset

```bash
tools node-repl preset save settings-demo \
    --file demo.js \
    --params '{"pane":{"type":"string"},"title":{"type":"string","default":"Settings"}}' \
    --description "a captioned demo of one Settings pane"
tools node-repl preset list                  # a table; a * marks a param required at every run
tools node-repl preset list --json
tools node-repl preset show settings-demo    # metadata, folder and script as JSON
tools node-repl preset run settings-demo \
    --param pane=Appearance \
    --timeout 900000
tools node-repl preset rm settings-demo      # prints where in .trash/ it went
```

| Subcommand | Flags |
|---|---|
| `list` | `--json` |
| `save <name>` | `--file <path>` (required), `--description <text>`, `--toolset <list>`, `--params <json>` |
| `run <name>` | `--param <key=value>` (repeat it), `--timeout <ms>` (default `600000`) |
| `show <name>`, `rm <name>` | none |

See [Presets](#presets) for the store, the param types and the rules.

## Inside a turn

These globals exist in every turn, with or without toolsets:

| Global | What it does |
|---|---|
| `help(name?)` | No name: core help, one line per toolset. A toolset id: one line per method. |
| `search(query)` | The methods whose name, doc or parameter schema hold the words. |
| `describe(name)` | One method in full. `describe("movies")` lists a toolset. |
| `await show(x)` | Return an image to the model. |
| `await sleep(ms)` | Wait inside a turn. |
| `nodeRepl` | `write(value)`, `await emitImage({ bytes, mimeType })`, `cwd`, `homeDir`, `tmpDir`. |

- `help`, `search` and `describe` return their text. The last line of a turn prints it, and so does a bare call on
  its own line. Inside an expression, print it yourself: `console.log(describe("movies.Movie.cut"))`. Only the
  kernel's own functions print on a bare line; your own function named `search` does not.
- `describe()` with no name lists every name. It takes both the qualified handle names from `search`, such as
  `recorder.Recording.displays.switch`, and the names from `help`, such as `recording.displays.switch`.
- `show()` takes a path, a Buffer or Uint8Array, `{ path }`, `{ bytes, mimeType }`, or an array of them. The MIME
  hint is ignored: the bytes must identify a PNG, JPEG, GIF or WebP. `nodeRepl.emitImage()` is `show()` for one
  image's bytes, checked the same way. Each image is also written to a file under the temp dir, and the answer names
  the file.
- `nodeRepl.write(value)` appends to the turn's text: a string as it is, anything else through `Bun.inspect`.
- The last expression is the turn's result. When the turn ends in a `try`, an `if` or a block, the last expression
  of each branch is. A string comes back raw, anything else through `Bun.inspect`. A result that holds a Promise
  gets a note to `await` the call that made it.
- The whole console goes into the turn's text, `console.table`, `count` and `group` included.
- Lines written after a turn answered (a timer of an earlier turn, a failed turn whose code still runs) and errors
  no turn caught start the next turn's text. They never mix into that turn's own output. The last 20 late lines
  and the last 5 uncaught errors are kept, and the next turn's text says how many lines it dropped.
- A callback that the running turn scheduled and that throws fails that turn at once, with its own error. It does
  not wait for the turn's deadline.
- A failed turn's stack shows only the frames you wrote (the turn and a preset script, numbered as written). The
  full stack goes to the log at debug level.

Every toolset method carries a label. `[read]` changes nothing and reaches no one. `[reversible]` and `[destructive]`
change state. `· user` means the user meets it (a dialog, a window, focus, the clipboard, the inbox), and `· paid`
means a run billed to an account. A call that would reach someone its label does not declare is refused, and every
call is checked against its method's parameter schema.

## MCP tools

| Tool | Arguments | What it does |
|---|---|---|
| `js` | `code`, `timeout_ms`, `title` | Run JS or TS with top-level `await`. |
| `js_add_node_module_dir` | `path` | Make a folder's `node_modules` importable. |
| `js_reset` | none | Kill the worker and start a fresh one. |
| `turn_ended` | none | No-op, kept for hosts that send it. |

- `js` takes `{ "code": "...", "timeout_ms": 30000, "title": "..." }`; only `code` is required.
- `js_add_node_module_dir` takes `{ "path": "/abs/project" }`: an absolute directory that CONTAINS `node_modules`,
  which then resolves from `import()` inside the REPL. The registration survives `js_reset`.
- After `js_reset` every binding is gone, and the toolsets are disposed and preloaded again.
- `js` refuses an unknown argument, an empty `code`, a `timeout_ms` that is not a whole number of 1 or more, and a
  `title` that is not a string. A host may skip the input schema, so the server checks it again. The `title` is cut
  to 80 characters and labels the turn's log line.
- A `js` answer is a text block, then for each image an `image` block and a text block naming its file, then the
  error text when the turn failed (`isError: true`). `_meta["genesis/durationMs"]` holds the turn's time.
- The `js` description lists the preloaded toolsets, one line each, so the model sees them before its first call.
- A turn that overruns `timeout_ms` comes back as an error naming the limit, with a hint (`timeout_ms: 600000`).
  The worker was killed, so every binding is gone, exactly as after `js_reset`.
- `js_add_node_module_dir` refuses a relative path and a folder with no `node_modules`. A registration sent while
  a turn runs is answered beside it. A turn that keeps the CPU busy holds it, and after 30 s the answer says the
  worker gets the folder when the turn ends. The registration never kills the worker, and every binding stays.
- `js_reset` cancels the queued turns, and a running turn answers `cancelled by js_reset`. The toolsets get up to
  10 s to dispose. With `recorder` or `movies` loaded, owned recordings are stopped and finalized: a pending startup
  may take up to 120 s, then finalization up to 10 min. The answer names a recording that stopped with no frames,
  whose folder stays in the library. Registered module directories stay.

### A call sequence

```jsonc
// 1. keep a binding
js { "code": "let counter = 41;\ncounter" }                       // -> 41
// 2. a later, separate call sees it
js { "code": "counter + 1" }                                       // -> 42
// 3. make a project's node_modules importable
js_add_node_module_dir { "path": "/path/to/project" }              // -> "module directory registered: ..."
js { "code": "const { default: dayjs } = await import('dayjs');\ndayjs().year()" }
// 4. hand back an image: any PNG bytes, from a file or an encoder
js { "code": "const png = await Bun.file('/tmp/chart.png').bytes();\npng.length" }
js { "code": "await nodeRepl.emitImage({ bytes: png, mimeType: 'image/png' });\n'sent'" }
// 5. start over
js_reset {}                                                        // -> "REPL reset; bindings cleared"
```

The last call of step 4 returns an MCP `image` content block followed by a text block naming the file the bytes
were also written to.

## Toolsets

`--toolset a,b` (on `mcp` and `run`) preloads entries of the `REPL_TOOLSETS` table in `lib/toolsets.ts`:

| Toolset | What it gives |
|---|---|
| `computer` | Observe and operate native macOS apps (AX, CoreGraphics, Vision); call `get_app_state` first. |
| `control` | The `computer` API under the name `control`. Load `computer` or `control`, not both. |
| `recorder` | Start, attach to and control frames recordings (PNG frames for `editor`). |
| `editor` | Cut recordings and videos into frames, grids, trims, speed changes and exports. |
| `movies` | Record the screen as a movie, then cut, speed up, zoom and export it. |
| `meetings` | Meetings: transcripts, evidence and items; suggest, confirm and reject items; name speakers. |
| `browser` | Open, read, navigate, screenshot and close browser tabs through Chrome DevTools. |
| `hub` | Read pull requests across repository hosts. |
| `github` | Read GitHub pull request reviews. |
| `presets` | Save a script that worked as a named preset with parameters, and run it again. |

Inside a turn, `help("<id>")` lists a toolset's methods and `describe("<id>.<method>")` prints one in full. From a
shell: `tools node-repl run --toolset movies "help('movies')"`.

### How toolsets load

- The engine builds the toolsets once per worker, with a `preload` request that has its own budget (120 s), not the
  turn's, because a toolset may build a native binary first.
- After a timeout kill or `js_reset` the new worker preloads them again. A reset, the server's exit and the end of
  a `run` dispose them.
- A toolset that fails to load does not stop the others or plain JavaScript. Its global throws with its name and
  the reason until `js_reset`, `help()` names it, and the worker's first turn starts with
  `the <id> toolset did not load: …`.
- Each worker gets a private scratch folder for its toolsets (a browser screenshot, a still), removed when the
  worker stops.
- `computer,control` is refused: they are one API under two names, and with both every `search()` hit came back
  twice.
- For an experiment, an entry may also be `/abs/module.ts#ExportName`, a `ReplToolset` class outside the table.

### computer and control

The native Computer Use API of [control](../control/README.md). It needs the Accessibility and Screen Recording
grants (`tools control doctor` checks them). Its artifacts (screenshots) go to the worker's scratch folder.

### recorder, editor and movies

`recorder` starts, attaches to and controls screen recordings over the live recording socket: pause, resume, stop
after post-processing, `set`, `displays.*`, `audio.*`, `mark`, `on` and `waitFor`. `editor` opens a recording id or
a video, then makes frames, change-only frames, grids with `.show()`, trims, speed changes and exports, each a job
with progress. The `editor` toolset's frames, grids, trims and speed changes are not scratch: they stay under
`~/.genesis-tools/recordings/edits/<source>/` at full size, also for a scratch source, until removed (`tools rm`).
`export` writes where its `output` says.

- Recordings started in a turn belong to the parent engine. A turn timeout loses the bindings but leaves those
  recordings running: use `await recorder.list()` and `await recorder.attach(id)` in the next turn.
- `js_reset`, a normal server shutdown and the end of `run` stop owned recordings and await their post-processing.
- Library recordings use the same Vision OCR function as meetings when OCR is on (pass an `ocr` object to
  `recorder.start`), writing a JSON sidecar beside each kept frame whose text meets `minChars` (20 by default).
- The whole recorder and editor flow, live, in one `run --toolset recorder,editor` turn. It records 20 s of every
  display, mutes the system sound (the microphone with `--mic`), switches displays and back, changes the fps and
  stops. It makes change-only frames from 00:05 to 00:20, which stay in the edits folder like every `editor`
  output, and saves a 3 x 3 grid as PNG files (`grid-1.png` and so on) to the `--out` folder. It never moves the
  pointer, focuses an app or types; `--mic` adds the microphone, which may ask for its permission.

  ```bash
  bun src/node-repl/scripts/recorder-editor-demo.ts --out ~/Projects/app/repl-demo [--mic]
  ```

`movies` (`src/recorder/lib/toolset.ts`) records the screen as a movie (`record` returns a handle with status,
pause, resume and stop) and edits a recording's `edit.json`: `open(id)` returns a Movie with split, cut, keep, speed,
zoom, autoZoom, volume, mute, apply, undo, export, show and many more. `movies.demo({ steps })` records a script of
steps and captions each one into a finished demo. Its times are source seconds, and the open recorder window takes
each save as it lands. The edit is a file, so it outlives the worker, and `undo()` takes back the last change, one
of an earlier run too (up to 30 steps, kept in `<edit>.undo.json`). The CLI door to the same edits is
`tools recorder project` and `tools recorder apply`. The whole API and the editing workflow are in
[recorder](../recorder/README.md).

### meetings

- `meetings.list()` and `meetings.open(id)` (an id, a unique prefix or `"last"`). Also `overview` (the meetings of
  the last days, with their badges), `dictionary.test`, `config.get`, `config.set` and `captureCost`.
- On an opened meeting: `info`, `transcript`, `lines`, `evidence`, `items.list`, `items.add`, `items.suggest`,
  `items.confirm`, `items.reject`, `items.reopen`, `speakers.stats`, `speakers.rename`, `set` and `export`.
- The screen recording of a meeting: `screen` (the frames at a transcript time or that show a text),
  `screenTimeline` and `editorProject` (an editor project that `movies.open(folder)` edits). While the meeting is
  recorded, `settings`, `setSettings` and `mark` change and mark the recording.
- How a meeting finds its project: `projects.labels`, `projects.pair`, `projects.unpair`, `projects.people`,
  `projects.preview` and `assign.sweep`, and on a meeting `assign.proposals`, `assign.ask`, `assign.apply` and
  `set({ labels })`.

`help("meetings")` prints one line per method. See [meetings](../meetings/README.md).

### browser

`tabs`, `open`, `navigate`, `evaluate`, `screenshot` and `close` over the Chrome DevTools Protocol. Every call takes
the browser's CDP `port` explicitly. On a browser the user also uses, the tab changes in front of them: start your
own with `--remote-debugging-port` and `--user-data-dir` for work they should not see. `screenshot` writes a PNG to
the scratch folder; `await show(path)` returns it to the model. `evaluate` takes an expression or a function; wrap a
top-level `await` in `async () => { … }`. [chrome-devtools](../chrome-devtools/README.md) has click, fill and
snapshot.

### hub and github

`hub.prs({ paths: [nodeRepl.cwd] })` lists the open pull requests of local repository folders (`paths` needs at
least one folder; `limit` defaults to 30). `hub.pr({ ref: "owner/repo#42" })` reads one by its URL or repository
reference ([hub](../hub/README.md)). `github.review({ ref: "owner/repo#42" })` reads a pull request's review threads
and comments; it also takes `{ owner, repo, number }` ([github](../github/README.md)). Every method takes one
options object, so `hub.prs()` and `hub.pr("owner/repo#42")` are refused.

### Writing a toolset

A toolset is a `ReplToolset` subclass (`@genesiscz/utils/repl/toolset`) with an `ApiDescriptor`
(`@genesiscz/utils/api-descriptor`: per method a name, zod params and result, one line and an effect of `read`,
`reversible` or `destructive`) and a `bootstrap(ctx)` that returns its globals. Each toolset lives in one file and
has one row in `REPL_TOOLSETS`: its one-line summary, its global name when that differs from the id, and a `load()`
that imports the toolset only when a run names it (a test pins the row to the loaded toolset's `api`). So `--help`,
id parsing and the MCP start line load no toolset, and a toolset whose module throws at import fails alone. The
table lives in this tool, not in `@genesiscz/utils/repl`, because a toolset
may sit in a tool's folder (`computer` is in `src/control`) and `src/utils` may not import a tool. The smallest
example is `lib/__fixtures__/counter-toolset.ts`.

## Presets

A preset is a REPL script kept under a name with parameters, the way `tools scripts` keeps scripts. The `presets`
toolset and `tools node-repl preset` share one store: a folder per preset in
`~/.genesis-tools/node-repl/presets/<name>/`, with the code in `script.js` (edit it there) beside `preset.json`
(description, toolsets, params, run count). A script is the body of an async function: it reads `params` and
returns its result.

```js
await presets.save("settings-demo", {
    description: "a captioned demo of one Settings pane",
    script: `return await movies.demo({ title: params.title, steps: [
        { caption: "Open " + params.pane,
          run: () => computer.launch_app({ bundle_id: "com.apple.systempreferences" }) },
    ] });`,
    params: { title: { type: "string", default: "Settings" }, pane: { type: "string" } },
});
await presets.list();                                  // [{ name, toolsets: ["movies", "computer"], params, runs }]
await presets.show("settings-demo");                   // { meta, script, folder }
await presets.run("settings-demo", { pane: "Appearance" });
await presets.remove("settings-demo");                 // { trash }
```

- A name is 1 to 64 letters, digits, dots, dashes or underscores, and starts with a letter or a digit.
- Each param is `{ type?, description?, default? }`. `type` is `string` (the default), `number`, `boolean` or `json`.
  A missing required value is refused with its `description` (up to 300 characters). A param without a default is required at every
  run,
  and an unknown name or a value of the wrong type is refused before anything runs. On the command line,
  `--param` reads the text as the param's type: a boolean takes `true`, `false`, `1`, `0`, `yes`, `no`, `on` or
  `off`, and a `json` param takes JSON.
- `toolsets` defaults to the toolsets the script names (`movies.`, `computer.`). A run in the REPL needs them loaded
  and says which `--toolset` to start with. `tools node-repl preset run` starts a fresh REPL with them and `presets`.
- A script that does not parse is refused when you save it, not at its first run.
- Saving a name again replaces the preset and keeps its created time and run count. The version it replaced moves
  to `.trash/`, as a removal does: `.trash/<name>-<time>`, from where it can be moved back.
- Every run that finishes adds one to `runs` and sets `lastRunAt`.

## How it works

### Where data lives

| Path | What |
|---|---|
| `~/.genesis-tools/node-repl/trust.json` | The import policy ([Configuration](#configuration)). |
| `~/.genesis-tools/node-repl/presets/<name>/` | One preset: `script.js` and `preset.json`. |
| `~/.genesis-tools/node-repl/presets/.trash/` | Removed and replaced presets. |
| `$TMPDIR/node-repl-output-*/turn-<n>.txt` | The whole text of a turn that was cut; kept after the engine stops. |
| `$TMPDIR/node-repl-images-*/` | Every image a turn returned. |
| `$TMPDIR/node-repl-toolsets-*/` | A worker's scratch folder; removed when the worker stops. |
| `~/.genesis-tools/recordings/edits/<source>/` | The `editor` toolset's frames, grids, trims and speed changes. |
| `~/.genesis-tools/logs/<date>.log` | The log: each MCP turn, and worker stderr at debug level. |

### Why the REPL lives in a child process

`vm`'s own timeout only bounds synchronous code. A turn that loops on `await Promise.resolve()` starves the event
loop with microtasks and defeats every in-process timer, including a `setTimeout` race in the same process. So the
REPL scope is the global scope of `lib/worker.ts`, a child of the MCP server, and `lib/engine.ts` enforces
`timeout_ms` from the parent by killing and respawning it. A killed turn reports that every binding is gone, and the
processes it started (a `Bun.spawn`, a build) get SIGTERM with the worker, because nothing holds their handles any
more. `js_reset` is the same operation on purpose. There is no separate `vm` context: the process is the sandbox,
and a second realm only makes `Bun.inspect` print every object with its prototype.

- Turns run one at a time, in order. A turn's clock starts after the worker has booted, so bun's start (100 to
  300 ms) does not come out of the turn's budget.
- The worker talks to the engine in JSON lines on stdin and stdout. Its stderr is read all the time, because an
  undrained 64 KB pipe blocks the writer and looks like a long computation. A worker that dies before it answers
  quotes its last stderr lines (up to 8) in the error.

### How bindings persist

Each turn runs inside an async IIFE, where `let`, `const`, `class` and `function` would be local. `lib/rewrite.ts`
rewrites the top level of the turn with `oxc-parser`: variables become bare assignments, classes and functions
become `globalThis.Name = …`, and the last expression is returned. Redeclaring a name overwrites the property, which
is what a REPL means by it. TypeScript is stripped first with `Bun.Transpiler`.

### What it calls and what it costs

- `computer`, `control` and `recorder` use the native control helper, which may be built on its first use (a first
  preload or turn can take longer). `tools control doctor` checks the Accessibility and Screen Recording grants
  they need.
- `browser` talks to a browser's CDP port; `hub` and `github` read pull requests through the `tools hub` and
  `tools github` libraries. They use the GitHub token that `tools github` uses (the environment token or the gh CLI
  login), and fail without one; see [github](../github/README.md).
- A `movies` transcript that is not cached yet is a paid transcription and may ask the user for the AI vault key.
  Its method carries the `· paid` label. Plain JavaScript and every `[read]` method cost nothing.

## Configuration

### The import policy (`trust.json`)

Every `import()` inside a turn passes through one callback, which is the trust chokepoint for imports. It covers
`import()` only: `Bun.file`, `Bun.spawn` and `fetch` stay open to a turn. `~/.genesis-tools/node-repl/trust.json`
may set these keys:

```json
{
    "allowBuiltins": true,
    "allowRepoDeps": true,
    "allowPaths": true,
    "allowBare": ["left-pad"]
}
```

| Key | Default | Allows |
|---|---|---|
| `allowBuiltins` | `true` | `node:` builtins, and the same modules without the prefix (`fs`). |
| `allowRepoDeps` | `true` | Bare names that the server's own dependencies resolve. |
| `allowPaths` | `true` | Absolute paths, relative paths and `file:` URLs. |
| `allowBare` | `[]` | Exact bare names, always allowed. |

A directory added with `js_add_node_module_dir` allows the modules that resolve to a file inside it, and nothing
else. `data:` imports are always allowed. The policy is read when the worker starts and never changed by a turn. A
file that is not valid JSON, or a key of the wrong type, stops the worker, and every turn's error quotes the reason
(`"allowPaths" must be true or false`).

### Environment

`GENESIS_TOOLS_HOME` moves the `~/.genesis-tools` root (the tests use it as a sandbox).

### Registering the MCP server

One command per host, through the repo's MCP manager:

```bash
tools mcp-manager install node-repl "tools node-repl mcp" -p claude -t stdio   # or -p codex, cursor, gemini, grok, all
tools mcp-manager list                                                          # confirm it landed
```

By hand it is the same shape as every other server this repo owns:

```json
{ "command": "tools", "args": ["node-repl", "mcp"] }
```

Add `"--toolset", "movies,computer,presets"` to `args` to preload toolsets.

## For agents

- Over MCP, call `js` with `code` (and `timeout_ms` for a long turn). Read `help()`, `search()` and `describe()`
  before you guess a parameter.
- From a shell, `run` exits 1 on a failed turn and prints the error on stderr. `preset list --json`, `preset show`
  and `preset save` print JSON on stdout.
- The plugin skill `genesis-tools:node-repl`
  ([SKILL.md](../../plugins/genesis-tools/skills/node-repl/SKILL.md)) covers toolsets and presets; the
  `genesis-tools:recorder` skill covers `movies.demo` and editing.

## Troubleshooting

- **`turn exceeded 30000 ms; the worker was killed and every binding is gone`.** The turn ran past its budget. Pass
  `--timeout <ms>` to `run` (or `timeout_ms` to `js`), put a long script in a file, and define the bindings again.
- **`Cannot find package 'x'`.** The package is not in the server's dependencies. Register the project that has it
  with `js_add_node_module_dir`, or import it by absolute path.
- **`import of "x" is not allowed by …/trust.json`.** The import policy refuses it. Change `trust.json`; the next
  worker (after `js_reset`) reads it.
- **`the node-repl worker exited (code 1) before answering`, with stderr lines.** The worker could not start. A
  malformed `trust.json` is the usual cause, and the quoted lines name the key.
- **`the <id> toolset did not load: …; its global throws until js_reset`.** That toolset's backend failed (a missing
  grant, a native helper that did not build). Fix the cause, then `js_reset`.
- **`computer and control are one API under two names; load one of them`.** Drop one of them from `--toolset`.
- **`… holds no node_modules folder`.** `js_add_node_module_dir` takes the folder that contains `node_modules`,
  not `node_modules` itself.
- **`[output cut at 20,000 of … characters; all of it is in …]`.** Read the file the note names, or raise
  `--max-output`.
- **A result reads `Promise { … }`.** `await` the call that made it.
- **`no browser answers on CDP port 9222`.** Nothing listens on that port. Start the browser with the two flags the
  error names (`--remote-debugging-port=9222` and `--remote-debugging-address=127.0.0.1`). Two browsers can listen
  on one port (one on `127.0.0.1`, one on `[::1]`), so check with `lsof -nP -iTCP:9222 -sTCP:LISTEN` that only
  yours is there.

## Related

- [control](../control/README.md): the native app control behind `computer` and `control`.
- [recorder](../recorder/README.md): recordings, the `movies` toolset, demo mode and the editor window.
- [meetings](../meetings/README.md): the store behind the `meetings` toolset.
- [chrome-devtools](../chrome-devtools/README.md): click, fill and snapshot in the same browsers.
- [hub](../hub/README.md) and [github](../github/README.md): the pull request readers.
- [mcp-manager](../mcp-manager/README.md): registers the MCP server with each host.
- [scripts](../scripts/README.md): the script store that presets follow.
