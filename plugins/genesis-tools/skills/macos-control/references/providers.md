# Providers — what each agent host can actually reach

`tools control` is the default and works everywhere. This file is for the cases where the
user explicitly asks for a host's own computer use, or where you must explain why it is not
available.

🛑 **Element indexes and snapshot tokens are never portable between providers.** Each one has
its own numbering. Re-inspect through the provider you are about to act with.

⚠️ **A working CLI does not prove a host's native computer use works, and a working browser
tool proves neither.** Prove inspection, then one authorised harmless action, then refreshed
state, before claiming a provider works.

## GenesisTools — always available

`tools control see` / `act` / `cursor`, plus the selector commands. Needs macOS, Bun, a Swift
toolchain, and the Accessibility and Screen Recording grants. It does not import Sky, does not
need an OpenAI account, and does not need an agent session. Full contract in SKILL.md.

With the normal `tools` launcher, macOS attributes grants to `~/Applications/GenesisTools.app`
(`com.genesiscz.genesistools`), not to the terminal. Running `ax-tool` or Bun directly may use
a different responsible process and hit a different grant. Read the permission error rather
than assuming.

## Claude Code — native computer use

Tools are `mcp__computer-use__*`. The contract is completely different from Sky's:

- Call `request_access` first with the list of applications you need. The user approves each
  one. `list_granted_applications` shows the current allowlist and returns an empty list until
  then.
- References are **screen coordinates** against the returned screenshot, not element indexes.
  Applications outside the allowlist are excluded at the compositor level.
- Tiers are enforced by the frontmost-app check: browsers are read-only (visible, no clicks or
  typing), terminals and IDEs are click-only (no typing, no right-click, no modifier-click),
  everything else is unrestricted.
- For a web page prefer the browser MCP. For shell work use the Bash tool. Computer use is for
  native apps and cross-app flows.

Peekaboo is also present as `mcp__peekaboo__*` (single-shot inspection and interaction, opaque
element IDs plus a snapshot). It has no `capture` tool; recording is CLI only.

## Codex — native computer use through Sky

Sky is reached from the `node_repl` MCP server's `js` tool. Read the host's own computer-use
instructions before using the API.

```js
var sky = (await import("@oai/sky")).sky;
var state = await sky.get_app_state({ app: "com.apple.calculator" });
nodeRepl.write(state.text);
```

Copy the observed index of the intended control into the next call. `observedIndex` means the
index you just read, never a fixed example number:

```js
await sky.click({ app: "com.apple.calculator", element_index: observedIndex });
var state = await sky.get_app_state({ app: "com.apple.calculator" });
nodeRepl.write(state.text);
```

To view the screenshot returned for that same window:

```js
if (state.screenshot) {
  await nodeRepl.emitImage({
    bytes: await (await import("node:fs/promises")).readFile(
      (await import("node:url")).fileURLToPath(state.screenshot.url)
    ),
    mimeType: "image/png",
  });
}
```

API surface: `list_apps`, `get_app_state`, `click`, `press_key`, `type_text`, `scroll`,
`set_value`, `drag`, `perform_secondary_action`, `paste`, `select_text`. Full input shapes are
documented on disk at
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/docs/`.

If `sky is not defined`, re-import and inspect again. If you lost the prior AX text or cannot
interpret a diff, ask for `get_app_state({ app, disableDiff: true })`. Retry a failed
display-name lookup with the bundle ID from `list_apps()`. Do not reset a working REPL, do not
enable a guessed server, and do not ask for a session restart merely because another tool name
is absent.

## Any host — running `node_repl` yourself

Verified 2026-09-11. `node_repl` is an ordinary MCP stdio server, so a host without it built
in can still spawn it.

```text
binary: /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl
serverInfo: rmcp 1.5.0, protocol 2025-06-18
tools: js, js_add_node_module_dir, js_reset, turn_ended
```

Required environment, copied from how Codex launches it:

```text
NODE_REPL_NODE_PATH=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
NODE_REPL_NODE_MODULE_DIRS=/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules
NODE_REPL_TRUSTED_CODE_PATHS=<codex home>:/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules
NODE_REPL_TRUSTED_SERVICES={"sky":"@oai/sky/service"}
SKY_CUA_SERVICE_PATH=<codex home>/computer-use/Codex Computer Use.app
CODEX_HOME=<codex home>
```

Two things the client must do:

- **Declare the `elicitation` capability in `initialize`.** Without it every `get_app_state`
  fails with `nodeRepl.createElicitation is unavailable because the MCP client does not
  support form elicitation`.
- **Be ready to answer `elicitation/create`.** Sky gates computer use per application. An
  unapproved app answers `Computer Use was not approved to use <App>`. 🛑 That prompt is the
  user's decision. Never auto-approve it on their behalf; surface it and let them answer.

Two things that do NOT work:

- Importing `@oai/sky` under plain `node` throws `Sky Computer Use requires the trusted
  nodeRepl runtime`. The transport needs `globalThis.nodeRepl`.
- Connecting straight to the service socket at
  `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock`
  succeeds at the socket level and is then closed with no reply. The service authenticates its
  peer.

This route still requires the ChatGPT desktop app and its computer-use service to be
installed and running. It is therefore a convenience, never a dependency. Prefer
`tools control`.

## Peekaboo as a separate provider

Use it when Peekaboo is the chosen provider, or for recording. It is not Sky, and it does not
use GenesisTools snapshot tokens. See [peekaboo.md](peekaboo.md).
