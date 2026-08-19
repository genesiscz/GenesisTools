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

## What this tool manages, and what the registry knows

Two separate lists, and the distinction matters.

**The lifecycle list is `TARGETS` in [`src/dashboards/index.ts`](index.ts).** It is hardcoded, and every one of `up`, `down`, `restart`, `status` and `list` iterates it. Each entry pairs a key with the argv used to launch that dashboard, for example `{ key: "shops", args: ["shops", "ui"] }`, because there is no way to derive "how do I start this" from a port number.

❗ **Adding a dashboard to the registry alone does not make this tool manage it.** It will not start, stop or appear in `list` until it also has a `TARGETS` entry. If you add a dashboard and `tools dashboards status` never mentions it, that is why.

**The port and metadata registry is [`src/utils/ui/dashboards.ts`](../utils/ui/dashboards.ts)**, which holds browser dashboards in `DASHBOARDS` and non-browser listeners (HTTP APIs, extensions, proxies) in `WEB_SERVICES`. Ports must be unique across both, and `findPortConflicts()` enforces that. Never hardcode a port for a repo web server; look it up there.

`list` joins the two: it walks `TARGETS` and pulls each entry's display name and port out of `DASHBOARDS`. So `list` answers "what does this tool manage, and where does it listen", not "what is in the registry".

## Notes

- Individual dashboards keep their own lifecycle commands, for example `tools dev-dashboard ui`, `tools shops ui`, `tools youtube ui up`. This tool is the fleet-level view, not a replacement for them.
- `down` only stops launchd-managed instances. A dashboard you started by hand in a terminal is not managed, so stop it where you started it.
