# Short recordings with verified targets

`tools control capture` runs timed recording plans through Peekaboo, then produces frames and contact sheets. This is separate from native Computer Use and from the `see`/`act` snapshot contract. Recording requires the installed Peekaboo CLI. Other control commands do not.

Read the current contracts before authoring a plan:

```bash
tools control capture --help
tools control capture preflight --help
peekaboo capture live --help
```

Inspect the intended target and screens:

```bash
tools control capture preflight --app Calculator
```

Verify the app/window and geometry in the result. A suggested plan is a starting point, not proof it chose the right window. If the user chose one window, do not broaden the capture to the entire screen to avoid a targeting failure. Dynamic titles and transient windows can invalidate a selection; inspect again instead of substituting the largest or frontmost window.

## Author and run

Use a short explicit duration, normally three seconds when unspecified. Check the `capture --help` plan schema for `capture`, `focus`, `actions`, timing, crop and annotation fields. Coordinate input with other sessions and the user before recording.

```bash
tools control capture plan.json \
  1>/tmp/control-capture-result.json \
  2>/tmp/control-capture-error.log
tools json /tmp/control-capture-result.json
```

Keep stdout and stderr separate and check the exit status. The runner's existing selector-based actions do not carry `see` snapshot guarantees. Do not embed `see` tokens as if the recording runner revalidated them. Use this runner for known, stable timed sequences; use inspect/act/refresh for adaptive exploration.

For a motion event, model/tool-call latency is unsuitable for precise timing. Put action offsets in the plan. If any action times out, inspect the current target before replaying the plan; some earlier actions may already have completed. Do not retry mutating plans merely because capture output is empty.

## Review

Read warnings and per-action results first. A successful event dispatch does not prove visible motion. Check actual versus planned action timing, the first captured frame's app/window, and the contact sheet. Open individual frames where a visual change needs closer inspection. One retained frame can be legitimate for a static screen, but does not prove a requested transition was recorded.

Review PNG contact sheets for motion rather than animated GIFs, whose later frames may not be visible to the image reader. Crops use frame pixels; window geometry uses screen points. Derive scale from the observed frame dimensions, not a guessed Retina multiplier. Negative screen coordinates are valid on multi-display systems.

## Failure handling

- Missing permission: report the exact responsible provider/process and grant error. Do not reinterpret it as no content.
- Failed focus or wrong window: stop before capturing another app. Reinspect the intended app and window.
- Empty output or process crash: inspect stderr, runner warnings and the target's current state. A capture-only retry can be reasonable; an action sequence needs state verification first.
- Concurrent captures or keyboard work: serialize them. A screenshot does not reserve the desktop.
- Unsupported flag or plan field: consult installed help. Do not copy syntax from an older Peekaboo or MCP example.

Publishing is optional. Read [vitrinka.md](vitrinka.md) only when the user asks to share or annotate the evidence.