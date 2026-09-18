# computer-use

An independent macOS Computer Use API and MCP server over GenesisTools' native Accessibility, CoreGraphics and Vision code. It does not import or call Codex Computer Use, Sky, AppleScript or a browser automation service.

```bash
tools computer-use prepare             # compile the native backend before latency-sensitive work
tools computer-use mcp                 # native UI tools over stdio
tools computer-use mcp --repl          # persistent JS/TS; global computer is preloaded
tools computer-use run --file task.ts  # one script from the shell
```

The same entry points are reachable through `tools jev control mcp` and `tools jev control computer-run`.

```ts
const state = await computer.get_app_state({
    app: "com.example.App",
    image: false, // fast AX-only state; enable images for screenshot coordinates
});
const match = computer.find({ app: state.app, query: "Save" }).elements[0];
const result = await computer.click({ app: state.app, element_ref: match.ref });
nodeRepl.write(result.state?.text);
```

For a direct Bun import:
`import { ComputerUse } from "../control/lib/computer-use/session"; const computer = new ComputerUse();`
Use the repository REPL or Bun; no OpenAI runtime is required.

## API

- `get_app_state`: retained revisions, indexed elements, AX text, automatic diffs, optional native screenshot/OCR.
- `list_apps`: running native apps and bundle IDs.
- `click`, `drag`, `scroll`: observed references or image coordinates. Accessible single clicks use an observed AXPress; `physical:true`, right and double clicks use native pointer events.
- `set_value`, `select_text`, `paste`, `type_text`, `press_key`, `focus`, `perform_secondary_action`.
- `find`: local search over retained observations; no AI.
- `resolve_target`: exact selection by default; `chooser:"jev"` or `"auto"` explicitly enables Jev. `within_ref` narrows to an observed subtree.
- `verify_state`: fresh exact readback, or semantic verification with explicit `jev:true`.
- `close_session`: discard cached state, without quitting the app.

Every asynchronous call accepts an optional `signal` in its argument object. The native bridge owns and bounds its child process group. Ordinary UI calls use no AI; the only AI request path is Jev, through `provider:"typesafe"` or `"vercel"`. An uncertain chooser returns evidence for the current host; it never starts another model.

```ts
const chosen = await computer.resolve_target({
    app: "com.example.App",
    intent: "Open the account preferences",
    chooser: "auto",
    provider: "typesafe",
});
if (chosen.ref) {
    const acted = await computer.click({ app: "com.example.App", element_ref: chosen.ref });
    nodeRepl.write(acted);
}
```

## Reference and coordinate contract

Use `element_ref` from the latest state. A stale revision is refused. Numeric `element_index` works immediately after `get_app_state`; after an action, observe again or use an explicit ref/revision from its returned state. Actions return dispatch facts separately from task verification. Unknown delivery never retries.

Coordinates default to **pixels of the returned window screenshot**, with origin at its top-left. The API converts Retina scale and negative screen origins explicitly. Set `coordinate_space:"screen"` only for logical global screen points. Coordinate actions consume screenshot evidence once and revalidate pixels before dispatch; visual evidence expires after 30 seconds.

Typing/paste/keys require the target app/window/input to be focused. Call `focus` explicitly; there is no global keyboard fallback. `type_text` is single-line and at most 256 UTF-16 units; use `paste` for longer or formatted text. Paste restores the clipboard best effort. Secondary actions must match currently exposed AX actions.

Multiwindow apps require `window_id` or `window_index` on the initial observation. Later observations stay on that window. A replaced app instance invalidates the session. Eight apps may be retained per client.

## MCP configuration

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "tools",
      "args": ["computer-use", "mcp"]
    }
  }
}
```

Use `["computer-use","mcp","--repl"]` for the four node-repl-compatible tools (`js`, `js_reset`, `js_add_node_module_dir`, `turn_ended`) with `computer` preloaded. The native tool server and REPL server use the same API implementation; each server owns its own state.

## Verification and current limits

`bun src/control/scripts/live-smoke.ts --background-only --computer-api` creates a disposable native app, briefly focuses it for keyboard/paste checks, restores the prior foreground app when appropriate, and tests the API, a separate stdio MCP process, and two persistent REPL cells. It uses neither Codex nor Sky.

The backend needs the existing GenesisTools launcher permissions for Accessibility and Screen Recording. First-use compilation can take longer than an ordinary action deadline; prepare first. The current app list contains running apps, and the snapshot-safe key vocabulary is narrower than the legacy global hotkey vocabulary; app lifecycle and broader key support are being added in this work pass.
