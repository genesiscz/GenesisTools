# node-repl

A persistent JavaScript/TypeScript REPL for agents, exposed as an MCP stdio server. It is a
GenesisTools-native equivalent of Codex's `node_repl`: the same four tool names, no Codex, no
OpenAI runtime.

```bash
tools node-repl mcp                     # MCP stdio server
tools node-repl run 'const a = 1; a+1'  # one turn from the shell
echo 'await import("node:os")' | tools node-repl run
```

## Tools

| Tool | What it does |
|---|---|
| `js` | Run JS or TS with top-level `await`. Arguments `{ "code": "...", "timeout_ms": 30000, "title": "..." }`; only `code` is required. The last expression is the result; a string comes back raw, anything else through `Bun.inspect`. |
| `js_add_node_module_dir` | Register an absolute directory whose `node_modules` resolves from `import()` inside the REPL. Argument `{ "path": "/abs/project" }`, the directory that CONTAINS `node_modules`. Survives `js_reset`. |
| `js_reset` | Kill the worker and start a fresh one; every binding is gone. |
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
{ "command": "/Users/Martin/Tresors/Projects/GenesisTools/tools", "args": ["node-repl", "mcp"] }
```
