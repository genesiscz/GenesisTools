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
| `js` | Run JS or TS with top-level `await`. `code`, optional `timeout_ms` (default 30000), optional `title`. |
| `js_add_node_module_dir` | Register an absolute directory whose `node_modules` resolves from `import()` inside the REPL. Survives `js_reset`. |
| `js_reset` | Kill the worker and start a fresh one; every binding is gone. |
| `turn_ended` | No-op, kept for hosts that send it. |

Inside a turn the global `nodeRepl` offers `write(value)` (append to the turn's text output),
`await emitImage({ bytes, mimeType })` (an MCP image block plus a file under the temp dir, whose
path is also returned as text), `cwd`, `homeDir` and `tmpDir`.

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

Same shape as every other server this repo owns:

```json
{ "command": "/Users/Martin/Tresors/Projects/GenesisTools/tools", "args": ["node-repl", "mcp"] }
```

`tools mcp-manager install` writes that into whichever host configs are enabled.
