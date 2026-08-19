# tools dashboards

> **Orchestrate every GenesisTools web dashboard at once.**

The toolkit ships a dozen web UIs and listeners. This is the switch that brings them all up or all down, in the right order, without you remembering which one is an API the others depend on.

---

## Commands

| Command | Description |
|---------|-------------|
| `up` | Start all dashboards, API servers first |
| `down` | Stop all launchd-managed dashboards, UIs first and API servers last |
| `restart` | Restart all dashboards |
| `status` | Print status for each dashboard |
| `list` | List registered dashboard keys and ports |

## Quick start

```bash
tools dashboards list                       # what exists, and on which port
tools dashboards status
tools dashboards up
tools dashboards up --open                  # also open the browsers
tools dashboards down
tools dashboards down --except dev-dashboard
tools dashboards restart --except shops,youtube
```

## Options

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--except <keys>` | `up`, `down`, `restart`, `status` | Comma-separated dashboard keys to skip |
| `--open` | `up`, `restart` | Auto-open browsers (default: off) |

---

## Ordering is deliberate

`up` starts **API servers first**, then the UIs that call them. `down` reverses it: **UIs first, API servers last**. A UI that starts before its API shows errors until it retries, and an API killed before its UI produces a wall of failed requests. Doing it in order avoids both.

## Where the port list comes from

Nothing here is hardcoded per tool. The registry is [`src/utils/ui/dashboards.ts`](../utils/ui/dashboards.ts), which holds browser dashboards in `DASHBOARDS` and non-browser listeners (HTTP APIs, extensions, proxies) in `WEB_SERVICES`. Ports must be unique across both, and `findPortConflicts()` enforces that.

`tools dashboards list` prints the registry, which is the answer to "what is supposed to be on port 3073".

## Notes

- Individual dashboards keep their own lifecycle commands, for example `tools dev-dashboard ui`, `tools shops ui`, `tools youtube ui up`. This tool is the fleet-level view, not a replacement for them.
- `down` only stops launchd-managed instances. A dashboard you started by hand in a terminal is not managed, so stop it where you started it.
