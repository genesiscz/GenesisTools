---
name: node-repl
description: Drive GenesisTools from a persistent JavaScript REPL (tools node-repl, its MCP server and toolsets such as computer, movies, recorder, meetings, browser) and keep scripts that worked as named presets with parameters that run again with other values. Use for "run this in the node repl", "which toolset has X", "save this script as a preset", "run the preset again with another url", "list my presets", or before writing a multi-step agent script against the native control, recorder or browser APIs.
---

# Node REPL: toolsets and presets

`src/node-repl/README.md` is the full reference (`tools node-repl --readme`). Inside a turn, `help()`, `search("cut")`
and `describe("movies.demo")` print the loaded toolsets' real signatures; read them before you guess a parameter.

## Toolsets

Load what the task needs: `tools node-repl mcp --toolset movies,computer,presets` (or `run --toolset …` for one turn
in a fresh process). Bindings survive between `js` calls of the MCP server, never between `run` calls.

## Presets (save a script that worked, run it again)

1. Get the script right in the REPL first. A preset is the body of an async function: it reads `params` and `return`s
   its result.
2. Save it: `await presets.save("signup-demo", { script, description, params: { url: { type: "string", default:
   "https://example.org" }, steps: { type: "number" } } })`. A param with no default is required at every run;
   `toolsets` defaults to those the script names (`movies.`, `computer.`).
3. Run it with other values: `await presets.run("signup-demo", { url: "https://staging.example.org" })` in the REPL,
   or `tools node-repl preset run signup-demo --param url=https://staging.example.org` from a shell (a fresh REPL with
   the preset's toolsets). An unknown or missing value is refused before anything runs.
4. `presets.list()` / `tools node-repl preset list` shows each preset's params and run count;
   `presets.remove(name)` / `preset rm` moves it to `.trash/`.

A recorder demo is the usual preset: `movies.demo({ steps })` with the varying parts (a URL, a pane, a title) as params
(the recorder skill, "Demo mode").
