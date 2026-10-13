---
paths:
  - "src/chrome-devtools/**"
  - "src/utils/chrome-devtools/**"
---

# tools chrome-devtools and the shared CDP library

Loaded by Claude Code when you read, write or edit a file under `src/chrome-devtools/` or `src/utils/chrome-devtools/`.

- **`src/utils/chrome-devtools/` is vendored.** Another repository copies this folder as it is. Use only `node:` APIs there (no `Bun.file`, `Bun.spawn`, `Bun.$` or any other Bun-only API), and import nothing from outside `src/utils/`.
- **Never build on chrome-devtools-mcp.** It was slow and fragile: a 26 s accessibility snapshot on a 60-tab browser, and a page selection that followed the user from tab to tab. New browser automation goes through `src/chrome-devtools/lib/`: `dom/` (page agent, isolated world, open shadow roots, label lookup in `dom/find.ts`), `tab-driver.ts` (main-world scripts by tab id, load and request waits), `tabs.ts` and `cdp.ts`. CLI: `tools chrome-devtools snapshot|click|fill|scroll`.
- **Two browsers can listen on one CDP port.** A Chrome started while another one holds `127.0.0.1:<port>` binds only `[::1]:<port>`, without an error, and the tools connect to 127.0.0.1, so a test can drive another session's browser. Before a live test, `lsof -nP -iTCP:<port> -sTCP:LISTEN` must show exactly one pid, and `ps -o command= -p <pid>` must show your `--user-data-dir`. Start a test browser with `--remote-debugging-address=127.0.0.1` on a port nobody listens on.
- **Local Network Access (Chrome 145 and later)** blocks a request from a public page to `localhost` or a private address. The failed request carries `corsErrorStatus.corsError: LocalNetworkAccessPermissionDenied` or `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. `tools chrome-devtools grant` grants `local-network` and `loopback-network` (`Browser.setPermission`) for one origin. The origin must be secure, and the grant ends when the CDP session detaches.
