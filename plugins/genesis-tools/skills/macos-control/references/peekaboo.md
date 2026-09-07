# Peekaboo as a separate provider

Use this only when Peekaboo is the selected provider or needed for recording. It is not native Sky Computer Use and does not use GenesisTools snapshot tokens.

The examples below were checked against Peekaboo 3.9.4 help. A machine with another version must check its own help; MCP schemas and CLI flags can differ even on the same machine.

```bash
peekaboo --version
peekaboo see --help
peekaboo click --help
peekaboo window list --help
```

Inspect the selected app's windows, choose the intended current `window_id`, then capture it. Replace `WINDOW_ID` with that observed ID:

```bash
peekaboo window list --app Calculator --json
peekaboo see \
  --app Calculator \
  --window-id WINDOW_ID \
  --path /tmp/peekaboo-calculator.png \
  --json
```

Read the returned snapshot and opaque element IDs exactly as provided. Do not infer roles from an ID prefix, and do not reuse an ID from an earlier inspection. With `SNAPSHOT` and `ELEMENT_ID` copied from the current result:

```bash
peekaboo click \
  --snapshot SNAPSHOT \
  --on ELEMENT_ID \
  --json
```

Inspect again and view the screenshot before deciding the next action. If focus fails or the returned app/window differs, stop the sequence and inspect the intended target. Do not fall back to a frontmost screenshot.

In the checked CLI, coordinate clicks become window-relative when app/window targeting flags are supplied, and background delivery is the default. These semantics differ from other tools. Prefer observed element IDs; check `click --help` before coordinate or foreground input. Never transpose a screenshot's pixels directly into another tool's coordinate system.

MCP availability is discovered from the host's actual tool list. Some versions expose capture tools, others do not. Never claim a tool is present or absent based only on the provider's name. No AI analysis flag is needed for basic inspection; do not send screenshots to another model unless the task calls for it.