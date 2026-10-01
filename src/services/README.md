# services

`tools services` lists every long-running GenesisTools server on this Mac, shows which ones still
run code from before the last change, restarts them, and stops on-demand servers nobody uses.
Agent sessions (`gt-cc`, `gt-claude`, `gt-task` and anything started inside them) are never listed,
so nothing here can restart or stop one.

A service is one of:

- a registered port (`src/utils/ui/dashboards.ts`) whose listener passes that entry's process check;
- a running `com.genesis-tools.*` launchd job (the tools daemon, the MCP gateway, ai-proxy, and any
  dashboard installed with `install`).

```bash
tools services                    # the table: port, pid, uptime, launchd or detached, code age
tools services list --json        # the rows with the changed files
tools services restart            # pick in a terminal; services on old code are preselected
tools services restart --stale    # every service on old code
tools services restart mcp-gateway youtube
```

**Old code** means a commit since the process started, or an uncommitted edit newer than it, under
the service's own `src/<tool>/` or `src/utils/`.

**Restart** goes through launchd for a launchd job (`launchctl kickstart -k`, or `tools daemon
restart` for the daemon), since KeepAlive owns it and a kill would only respawn it. A detached
server is stopped (its whole process tree, SIGKILL after 10 s) and started again with its own
arguments, so a server started on one folder or port comes back the same.

`tools update` offers the same restart after it pulls, for the services on old code.

## Idle shutdown

```bash
tools services idle install --idle-hours 24   # daemon task, every 15 minutes
tools services reap-idle --dry-run            # what it would stop now
tools services idle uninstall
```

Only detached servers with a port are candidates, meaning the ones started on demand (for example by
a click through the browser router's `local-services` preset). A launchd job is never stopped: it is
installed to stay up. A server counts as in use while any client holds a connection to its port (an
open browser tab keeps a dev server's socket). The state lives in
`~/.genesis-tools/services/config.json`.

The library is `src/utils/services/`: `inventory.ts`, `stale.ts`, `lifecycle.ts`, `idle.ts`, and
`ensure.ts` (start a registered port, used by `tools browser-router ensure`).
