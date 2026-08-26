# Maximum capture: settings, columns, flags, net-export, Brave Shields

Everything to turn on before reproducing a bug, plus how to start a `chrome://net-export/`
capture and what Brave's Shields do to requests behind your back.

Further: `net-panel-symptoms.md` (reading the result) ·
`net-export-recipes.md` (analysing a net-export log).

---

## 3. Every setting, flag and source for maximum logging

### 3.1 DevTools network panel settings (the panel gear icon)

| Setting | Effect | Default |
|---------|--------|---------|
| **Preserve log** | Keeps request rows across page navigations. Headers/timing preserved; response body NOT preserved (see §2.1). | Off |
| **Disable cache** | Forces all requests to bypass the HTTP cache (equivalent to Ctrl+Shift+R for every request). Only active while DevTools is open. | Off |
| **Capture screenshots** | Records filmstrip screenshots of the viewport during load. | Off |
| **Show overview** | Shows the timing waterfall overview above the requests table. | On |
| **Group by frame** | Groups requests by the iframe/frame that initiated them. Useful for multi-frame pages. | Off |
| **Big request rows** | Two-line rows: top = transferred size, bottom = uncompressed size; Priority column shows initial + final priority. | Off |

### 3.2 Filter bar options

| Filter | Where | What it does |
|--------|-------|--------------|
| **Hide data URLs** | More filters → Hide data URLs | Removes `data:` URIs from the table |
| **Hide extension URLs** | More filters → Hide extension URLs | Removes `chrome-extension://` requests |
| **Blocked response cookies** | More filters → Blocked response cookies | Shows only requests where a cookie was blocked from being set |
| **Blocked requests** | More filters → Blocked Requests | Shows only requests that were blocked (red rows) |
| **3rd-party requests** | More filters → 3rd-party requests | Shows only requests whose origin differs from the page origin |
| **Filter box** | Inline text box | Supports `domain:`, `mime-type:`, `status-code:`, `larger-than:`, `is:running`, `has-response-header:`, `method:`, `scheme:`, `url:`, and many more |

### 3.3 Columns to enable (right-click the header row)

Right-click any column header to add/remove columns:

| Column | What it shows | When useful |
|--------|--------------|-------------|
| **Connection ID** | Numeric ID of the TCP/QUIC connection. Requests sharing the same ID reuse the same socket. | Debugging connection pooling, HTTP/2 multiplexing |
| **Protocol** | `http/1.1`, `h2`, `h3`, `ws`, `wss` | Confirming HTTP/2 or HTTP/3 upgrade |
| **Priority** | Two values in big-row mode: initial (bottom) and final (top) Fetch priority | Diagnosing resource loading order |
| **Initiator** | Script filename + line, or "Parser", or "(other)" | Tracing which code caused a request |
| **Set-Cookies** | Count of `Set-Cookie` headers | Cookie debugging |
| **Has overrides** | Whether request/response was modified by a DevTools override rule | Override debugging |
| **Method** | GET / POST / OPTIONS … | Filtering by HTTP verb |
| **Path** | URL path without host | Cleaner view for same-origin requests |
| **Domain** | Hostname only | Identifying third-party requests |
| **Remote address** | `IP:port` of the server that responded | Confirming CDN edge or direct origin |
| **Remote address space** | Public / Private / Local | For Private Network Access (PNA/LNA) debugging |
| **Time** | Total elapsed from request start to last byte | Performance regression hunting |
| **Cache-Control** | Response `Cache-Control` header value | Cache policy audit |
| **Content-Encoding** | `gzip` / `br` / `zstd` / empty | Verifying compression |
| **Waterfall** | Visual timeline bar | Default on; shows queuing/stalling/TTFB/download phases |

Custom response headers: right-click header → Response Headers → Manage Header Columns → Add custom header. Useful for adding `X-Request-ID`, `ETag`, `CF-Ray`, etc.

### 3.4 DevTools Settings → Preferences → Network

Navigate via the ⚙ gear icon in the top-right of DevTools (not the panel gear):

| Setting | Path | Effect |
|---------|------|--------|
| **Allow to generate HAR with sensitive data** | Settings → Preferences → Network | Enables the "Export HAR (with sensitive data)" option that includes `Cookie`, `Set-Cookie`, `Authorization` headers |
| **Custom HAR columns** | Right-click header → add custom | Per-session only |

### 3.5 DevTools Settings → Experiments

Open DevTools Settings → Experiments (you may need to enable `chrome://flags/#enable-devtools-experiments` first on Brave):

| Experiment | Effect |
|-----------|--------|
| **Network panel: show request headers on new line** | Readability improvement for long headers |
| **Protocol monitor** | Shows raw Chrome DevTools Protocol messages — useful for seeing what DevTools itself sends/receives |
| **Enable advanced network conditions** | Additional throttling and condition simulation options |

Brave tracks Chromium closely (the build verified for this doc reports Chromium 151) — most "graduated" experiments from earlier majors are now permanent features.

### 3.6 `chrome://net-export/`: usage and content

This is the strongest capture tool of the lot. It operates at the network-process level, below DevTools.

**How to use:**

1. Open a new tab → `chrome://net-export/`
2. Select logging level:
   - **Strip private information** (default): strips cookies, auth headers, but keeps event structure
   - **Include cookies and credentials**: adds `Cookie`/`Set-Cookie`/`Authorization` to events
   - **Include raw bytes**: adds the raw wire bytes (`SOCKET_BYTES_SENT/_RECEIVED`, encrypted for TLS) AND the decrypted plaintext (`SSL_SOCKET_BYTES_SENT/_RECEIVED`) per socket; QUIC/HTTP3 logs `QUIC_SESSION_*` packet events, with no decrypted-byte export equivalent
3. Click **Start Logging To Disk**
4. Reproduce the problem in a **different tab** (keep the net-export tab open)
5. Click **Stop Logging**
6. Load the resulting JSON at https://netlog-viewer.appspot.com — with cookies or raw bytes enabled the file holds live credentials; the viewer is a static page that parses in your browser (no upload), but treat the JSON itself like a credentials file and never share it unstripped

**Command-line equivalent (for startup-time problems):**
```
--log-net-log=/tmp/net-export.json
--net-log-capture-mode=IncludeSensitive    # or Everything
--net-log-max-size-mb=200                  # limit file size (Chrome M117+)
```

**What the JSON contains:**

The file is a JSON object with:
- `constants`: maps integer event type IDs to human-readable names (e.g. `354 → "URL_REQUEST_START_JOB"`)
- `events`: array of event objects, each with `time`, `type` (integer), `source` (`{id, type}`), `phase` (0=none, 1=begin, 2=end), and `params`

The `source.type` identifies the kind of network object:
- `URL_REQUEST` — top-level request
- `HTTP_STREAM_JOB` — stream connection job (one per HTTP/QUIC connection attempt)
- `SOCKET` — raw TCP/QUIC socket
- `HOST_RESOLVER_IMPL_JOB` — DNS resolution
- `CERT_VERIFIER_TASK` — certificate chain verification

**Top 5 event types to grep for:**

| Event type name | What it means |
|----------------|---------------|
| `URL_REQUEST_START_JOB` | A URL request began. Params contain `url`, `method`, `load_flags`. Start here when tracing a request. |
| `HTTP_TRANSACTION_READ_RESPONSE_HEADERS` | Response headers were received. Params contain the raw status line and headers. |
| `URL_REQUEST_JOB_FILTERED_BYTES_READ` | Decompressed/decoded response body bytes were read. Present only with `Include raw bytes`. |
| `URL_REQUEST_STATUS_CHANGED` | The request status changed. When followed by no further events on the same source, the request ended. |
| `CANCELLED` / `ERR_ABORTED` | The request was cancelled. Look at the params for `net_error` (negative integer mapping to an `ERR_*` code). |

### 3.7 `chrome://net-internals/` tabs

`chrome://net-internals/` is now mostly a set of static snapshots (the live event viewer was removed in 2018 and moved to the external netlog-viewer). What remains:

| Tab | Content | When to use |
|-----|---------|-------------|
| **Events** | Removed (2018). Use chrome://net-export/ instead. | — |
| **DNS** | Current state of the DNS resolver cache: cached lookups, TTLs, resolution mode (system/async). Has a "Clear host cache" button. | DNS staling issues, HSTS preloads, when a domain resolves to the wrong IP |
| **Sockets** | Pool of active and idle TCP/TLS sockets. Shows which sockets are in-use vs idle, connection parameters, error state. | "Max 6 connections per origin" stall diagnosis |
| **HTTP/2** | Active and recently closed HTTP/2 sessions. Shows stream IDs, HPACK table state, flow control window sizes. | H2 multiplexing issues, GOAWAY frames |
| **HSTS** | HTTP Strict Transport Security store. Can query whether a domain has HSTS. Has "Delete domain security policies" button. | Clearing stale HSTS entries, diagnosing forced HTTPS |
| **Proxy** | Active proxy configuration. | Corporate proxy / PAC script debugging |

To use the DNS tab: type the hostname and click "Lookup". It shows whether the resolution used the async DNS resolver or the system resolver, and what records were returned.

### 3.8 HAR export gotchas

1. **"Save all as HAR (sanitised)" vs "(with sensitive data)"**: The sanitised variant strips `Cookie`, `Set-Cookie`, `Authorization`, and `Proxy-Authorization` headers. For OAuth debugging, always use the sensitive-data variant (requires enabling in Settings → Preferences → Network first).

2. **Response body not in HAR**: Chrome only includes `response.content.text` for requests whose body was loaded into the DevTools front-end before export. If you exported immediately after page load without clicking each request, many bodies will be `""`. This is Chrome's design, not a HAR spec limitation.

3. **HAR 1.2 spec `bodySize` = -1**: HAR spec says `bodySize` should be -1 when the info is not available. Chrome uses `-1` for cache-served responses and for the rare case where headers don't include `Content-Length` and chunked transfer encoding is used.

4. **`timings.connect = -1`**: HAR spec instructs that `-1` means "does not apply" — i.e. the request reused an existing connection. Not a bug.

5. **Encoding field**: HAR 1.2 spec added `response.content.encoding` to support base64-encoded binary bodies. Chrome uses this for binary responses (images, fonts). If you see `"encoding": "base64"` in `content`, decode the `text` field with `atob()`.

6. **Large HAR files**: Chrome does not cap the HAR size itself, but response bodies contribute to the DevTools front-end's memory footprint. Very large responses (> ~64 MB) may be truncated.

Source: HAR 1.2 spec — http://www.softwareishard.com/blog/har-12-spec/

### 3.9 Brave specifics: Shields and fingerprinting protection

Brave adds significant network-level interceptors on top of Chromium. Shields' ad/tracker blocking is native browser code (the Rust `adblock-rust` engine in the browser process), not a `webRequest` extension, so it is harder to disable selectively and never shows up in the extensions list.

**What Brave Shields intercept at the network layer:**

| Protection | How it intercepts | DevTools effect |
|-----------|------------------|----------------|
| **Ad / tracker blocking (Standard mode)** | EasyList + EasyPrivacy + uBlock Origin + Brave internal lists, matched by the native adblock-rust engine before the request leaves the network stack. | Request shows `(blocked:other)` in Status, never reaches the server. |
| **Ad / tracker blocking (Aggressive mode)** | Same lists plus first-party trackers. More requests blocked. | Same as Standard. |
| **CNAME uncloaking** | DNS resolution exposes the real CNAME target; if it matches a tracker domain, the request is blocked. | Blocked requests may show the original domain, not the CNAME. DevTools does not surface the CNAME. |
| **Cross-site cookie blocking** | Third-party cookies stripped at the browser level before the request is sent. | Headers in DevTools show no Cookie header for third-party requests. |
| **Ephemeral storage** | Replaces third-party storage with per-session isolated storage. | No direct DevTools effect, but `document.cookie` may differ from what the server sees. |
| **Fingerprint randomization (Standard)** | Randomizes canvas, WebGL, AudioContext APIs. Does NOT block network requests. | No network panel effect. |
| **Fingerprint blocking (Aggressive)** | Blocks known fingerprinting scripts by URL. Uses webRequest block. | `(blocked:other)` in Status. |
| **Social media blocking** | Blocks Facebook, Twitter, LinkedIn widgets. | `(blocked:other)`. |
| **Script blocking** (manual) | When enabled per-site, all JS loaded from any origin is blocked. | Multiple `(blocked:other)` entries for every `.js` request. |

**To diagnose Brave-specific blocking:**
1. Click the Brave Shields lion icon → see the blocked count.
2. Disable Shields for the site (toggle off) — blocked requests should now succeed.
3. Cross-reference: open the same URL in a Chrome incognito window. If it works in Chrome but not Brave with Shields up, Shields is the culprit.
4. `brave://settings/shields` — global defaults. `brave://shields-internals` (brave://components) shows the filter list versions loaded.
5. Brave DevTools → Console: look for `ERR_BLOCKED_BY_CLIENT` messages.

**WebSocket and Brave:** Brave Shields can block WebSocket upgrade requests if the WS URL matches a tracker domain — the WS connection will fail with `(failed)` in DevTools. Disabling "Block fingerprinting" sometimes also unblocks WS connections because some WS handshakes include timing fingerprinting vectors.

Source: https://brave.com/shields/ ; https://github.com/brave/brave-browser/wiki/Fingerprinting-Protections

### 3.10 `chrome://flags`: network-relevant flags

| Flag | Chrome flag name | What it does |
|------|-----------------|--------------|
| **Private Network Access warnings** | `#private-network-access-send-preflights` | Controls whether PNA preflights are sent for private IP requests. Enabling shows the preflight in DevTools. |
| **CORS for content scripts** | `#cors-for-content-scripts` | Makes extension content scripts subject to CORS like normal web content. |
| **Block insecure private network requests** | `#block-insecure-private-network-requests` | Mixed-content enforcement for local network requests. Causes more `(blocked)` statuses for http:// requests to private IPs from https:// pages. |
| **Enable DevTools experiments** | `#enable-devtools-experiments` | Unlocks the Experiments tab in DevTools Settings. Required on some Brave versions. |
| **Partitioned cookies** | `#partitioned-cookies` | CHIPS — changes how cross-site cookies are sent; affects which Cookie headers appear in DevTools. |
| **Network service in process** | `#network-service-in-process` | Moves the network service back into the browser process (debugging aid). May change crash behavior but not DevTools visibility. |
| **Zero-copy video capture** | Unrelated — skip | — |

Access via `brave://flags` (Brave) or `chrome://flags` (Chrome). Search by keyword.

---
