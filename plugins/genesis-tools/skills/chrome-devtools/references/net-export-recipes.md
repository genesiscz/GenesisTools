# Below HTTP: what HAR drops, and how to grep a net-export log

A HAR is a DevTools-level artifact. Raw socket bytes, DNS decisions, TLS handshakes, CORS
preflight verdicts, and the numeric net error behind `(canceled)` exist ONLY in a
`chrome://net-export/` log. This file is what HAR omits (section 4), the practical
extraction recipes (section 5, including the OAuth token-endpoint checklist in 5.6), the
FAQ, and source links.

Further: `net-capture-settings.md` to produce the log · `net-panel-symptoms.md` to read the panel.

---

## 4. What HAR does not capture and net-export does

This is the single biggest reason to use net-export for hard debugging problems.

| Data | HAR | Net-export (default) | Net-export (raw bytes) |
|------|-----|----------------------|----------------------|
| **DNS queries** (wire-level) | No | Partial: `HOST_RESOLVER_IMPL_JOB` events show resolution time and result | Yes: `UDP_SOCKET` events show raw DNS packets |
| **DNS resolution mode** | No | Yes: shows whether system resolver or async DNS was used | Yes |
| **Socket pool events** (which TCP conn carried which request) | No | Yes: `SOCKET_POOL_BOUND_TO_CONNECT_JOB`, `SOCKET_POOL_REUSED_AN_EXISTING_SOCKET` | Yes |
| **TLS handshake details** | No | Yes: `SSL_CONNECT_JOB`, cipher suite, cert chain, OCSP stapling | Yes |
| **TLS decrypted bytes** | No | No | Yes (decrypted plaintext in `SSL_SOCKET_BYTES_RECEIVED` / `_SENT`; `SOCKET_BYTES_*` is the encrypted wire layer; QUIC traffic logs `QUIC_SESSION_*` packet events instead) |
| **CORS preflight decision** (pass/fail reason) | No | Yes: `HTTP_TRANSACTION_SEND_REQUEST_HEADERS` + response headers; error reason in params | Yes |
| **Private Network Access (PNA/LNA) enforcement** | No | Yes: `PRIVATE_NETWORK_ACCESS_CHECK` event with result | Yes |
| **Service worker fetch event hooks** | No | Partial: `SERVICE_WORKER_TRANSMISSION_FINISHED` | Partial |
| **Renderer-side abort reason** | No | Yes: `URL_REQUEST_STATUS_CHANGED` with `net_error` code | Yes |
| **Request body bytes** | `postData.text` (if body was logged) | No (never logs request body bytes in any mode) | No (request body is NOT captured by net-export) |
| **Response body bytes** | `content.text` (if loaded into DevTools) | No | Yes: `URL_REQUEST_JOB_FILTERED_BYTES_READ` |
| **Proxy resolution** | No | Yes: `PROXY_RESOLUTION_REQUEST` events | Yes |
| **Certificate verification details** | No | Yes: `CERT_VERIFIER_TASK` with chain, errors, OCSP | Yes |
| **Cookie inclusion/exclusion reason** | No | Yes: `COOKIE_INCLUSION_STATUS` per-cookie per-request | Yes |
| **HTTP/2 GOAWAY frames** | No | Yes: `HTTP2_SESSION_GOAWAY` | Yes |
| **QUIC connection events** | No | Yes: `QUIC_SESSION_*` events | Yes |
| **Extension-injected delays** | No | Yes: `URL_REQUEST_DELEGATE_*`, `NETWORK_DELEGATE_*` show when extensions blocked/modified the request | Yes |

Source: chromium.org/developers/design-documents/network-stack/netlog/ ; textslashplain.com analysis — https://textslashplain.com/2020/04/08/analyzing-network-traffic-logs-netlog-json

---

## 5. Practical recipes

### 5.1 Open a net-export log and find your URL

```bash
# Step 1: capture
# Open chrome://net-export/ → Start Logging → reproduce → Stop Logging
# File saved to ~/Downloads/net-export-log.json by default

# Step 2: open in viewer (browser-based, no install needed)
# PRIVACY: the log carries every cookie header, and with raw bytes the decrypted
# plaintext of the socket-level byte events (SSL_SOCKET_BYTES_*), which can hold
# request and response content. The appspot viewer parses the file in YOUR browser
# (it is a static page, no upload) — but for a log from someone else's machine,
# prefer the offline copy and treat the JSON like a credentials file.
# Navigate to https://netlog-viewer.appspot.com
# Drag net-export-log.json onto the page
# OR use the offline version: open viewer.html saved from netlog-viewer.appspot.com

# Step 3: in the viewer Events tab, type into the filter box:
type:URL_REQUEST
# then further filter by URL:
type:URL_REQUEST   (search box on right for your URL pattern)
```

### 5.2 Grep a net-export JSON for one URL's full lifecycle

The net-export JSON uses integer IDs for event types. The `constants.logEventTypes` dictionary at the top maps names → IDs. The following recipes work after you resolve the IDs:

```bash
# Extract the constant mappings first
cat net-export-log.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
types = data['constants']['logEventTypes']
# Build reverse map: id -> name
rev = {v: k for k, v in types.items()}
print(json.dumps(rev, indent=2))
" > /tmp/event-types.json

# Find all events for a given URL (two-pass: find source ID, then dump its events)
TARGET_URL="https://auth.example.com/token"

python3 - "$TARGET_URL" << 'EOF'
import json, sys

with open('net-export-log.json') as f:
    data = json.load(f)

# Find source IDs that contain our URL (substring match on the argv URL)
target = sys.argv[1]
source_ids = set()
for ev in data['events']:
    params = ev.get('params', {})
    if target in str(params.get('url', '')):
        source_ids.add(ev['source']['id'])

# Dump all events for those sources
for ev in data['events']:
    if ev['source']['id'] in source_ids:
        print(json.dumps(ev))
EOF
```

### 5.3 Filter only `URL_REQUEST` events

```bash
python3 << 'EOF'
import json

with open('net-export-log.json') as f:
    data = json.load(f)

# URL_REQUEST source type ID
src_types = data['constants']['logSourceType']
url_request_src_type = src_types.get('URL_REQUEST', 1)  # typically 1

for ev in data['events']:
    if ev['source']['type'] == url_request_src_type:
        print(json.dumps(ev))
EOF
```

### 5.4 Find why a request was cancelled: the net error code

```bash
python3 << 'EOF'
import json

with open('net-export-log.json') as f:
    data = json.load(f)

# Build event type name map
types = {v: k for k, v in data['constants']['logEventTypes'].items()}

for ev in data['events']:
    params = ev.get('params', {})
    net_error = params.get('net_error')
    if net_error is not None and net_error < 0:
        event_name = types.get(ev['type'], str(ev['type']))
        print(f"source_id={ev['source']['id']} event={event_name} net_error={net_error} params={params}")
EOF
# net_error codes: -3 = ERR_ABORTED, -7 = ERR_TIMED_OUT, -100 = ERR_CONNECTION_CLOSED,
# -101 = ERR_CONNECTION_RESET, -102 = ERR_CONNECTION_REFUSED, -200 = ERR_CERT_COMMON_NAME_INVALID
# Full list: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
```

### 5.5 Convert net-export to a readable timeline

```bash
python3 << 'EOF'
import json
from datetime import datetime

with open('net-export-log.json') as f:
    data = json.load(f)

# The timeTickOffset converts ticks to wall-clock time
tick_offset_ms = data['constants']['timeTickOffset']
types = {v: k for k, v in data['constants']['logEventTypes'].items()}
phases = {0: '', 1: '+BEGIN', 2: '-END'}

# Find base tick (earliest event)
events = data['events']
base_tick = min(int(e['time']) for e in events if 'time' in e)

for ev in sorted(events, key=lambda e: int(e.get('time', 0))):
    t_ms = int(ev.get('time', 0)) - base_tick
    phase = phases.get(ev.get('phase', 0), '')
    name = types.get(ev['type'], str(ev['type']))
    src = f"src:{ev['source']['id']}"
    params = ev.get('params', {})
    url = params.get('url', '')
    print(f"t+{t_ms:8}ms {src:12} {name}{phase:8} {url[:80]}")
EOF
```

### 5.6 OAuth token endpoint: the full checklist

When `/token` shows `Content-Length: 1126` in HAR but empty body:

```bash
# 1. Capture with net-export, Include raw bytes, Include cookies
# 2. Find the token request source ID:
python3 -c "
import json
data = json.load(open('net-export-log.json'))
for ev in data['events']:
    if '/token' in str(ev.get('params', {}).get('url', '')):
        print('Source ID:', ev['source']['id'])
        break
"

# 3. Dump all events for that source ID (replace 42 with actual ID):
python3 -c "
import json
data = json.load(open('net-export-log.json'))
types = {v: k for k, v in data['constants']['logEventTypes'].items()}
for ev in data['events']:
    if ev['source']['id'] == 42:
        print(types.get(ev['type']), ev.get('params', {}))
"

# Look for:
# - URL_REQUEST_START_JOB params: method=POST, url=.../token
# - HTTP_TRANSACTION_READ_RESPONSE_HEADERS: status 200, Content-Length header
# - URL_REQUEST_JOB_FILTERED_BYTES_READ: body bytes (only with raw bytes capture)
# - CANCELLED / ERR_ABORTED: why the renderer discarded the response
```

---

## Quick-fire FAQ

**Q: I see `Content-Length: 1126` in response headers but the body is `(empty)`. Was the response really empty?**

No. The server sent 1126 bytes. Chrome's network process received them. The body is missing from DevTools because either: (a) navigation happened before you clicked the Response tab, causing the renderer's in-memory copy to be discarded (§2.1); or (b) CORB/ORB stripped the body as an opaque cross-origin response (§2.5). Check the Console for CORB warnings. Use net-export with raw bytes to confirm what arrived.

**Q: What is the difference between `(canceled)` and `(failed)`?**

`(canceled)` means the request was **aborted client-side** — the browser tore down the request before a complete response, usually due to navigation, DOM removal, `AbortController.abort()`, form submission, or a browser extension. `(failed)` means a **network error** occurred — DNS failure, TLS error, TCP RST, CORS rejection, or similar. Both result in no response body.

**Q: `Preserve log` is on, but my POST body is gone after the redirect. What should I have done?**

`Preserve log` preserves metadata, not bodies. The fix: set a `beforeunload` breakpoint (Sources → Event Listener Breakpoints → Load → beforeunload), or use net-export with raw bytes, or use a proxy (Fiddler/mitmproxy) that captures outside the browser memory model.

**Q: Why do I see `(blocked:other)` for requests I recognise as legitimate?**

In Brave: Shields is blocking them. Click the Shields lion icon to see the count. Disable Shields for the site to confirm. Common triggers: URLs containing `track`, `analytics`, `advert`, `pixel`, `beacon` in the path; or the request domain matching EasyPrivacy/uBlock lists. In Chrome: a browser extension (uBlock, Privacy Badger) is blocking. Test in an incognito window with extensions disabled.

**Q: How do I find which TCP connection carried which HTTP/2 request?**

Enable the Connection ID column (right-click header → Connection ID). Requests with the same ID share the same underlying socket. In net-export, look for `HTTP_STREAM_JOB_BOUND_TO_REQUEST` events that link a stream job to a socket via `source_dependency`.

**Q: The HAR shows `timings.connect: -1`. Is the connection broken?**

No. HAR 1.2 spec §timings states `-1` means "does not apply". `connect = -1` means the request **reused an existing connection** — no new TCP handshake was needed. This is normal and good (keep-alive / HTTP/2 multiplexing working correctly).

**Q: Status column shows `CORS error`. How do I get the full reason?**

Hover the `CORS error` text in the Status column — Chrome shows a tooltip with the specific failing header or reason. Also check the Console tab for the full `Access-Control-*` header diagnostic. In net-export, look for `HTTP_TRANSACTION_READ_RESPONSE_HEADERS` params for the preflight (OPTIONS) request — the response headers will show whether `Access-Control-Allow-Origin` was missing or wrong.

**Q: I want to capture what Brave is blocking before it even sends the request. Can DevTools show that?**

DevTools shows requests that Brave's Shields has blocked — they appear as `(blocked:other)`. But Brave may also rewrite URLs or headers silently before sending (CNAME uncloaking, cookie stripping) — those modifications are NOT visible in DevTools. For full pre-send visibility, use net-export at the `IncludeSensitive` level, which captures headers as Chrome sends them after all modifications.

**Q: Is there a way to get both the request body AND the response body for an OAuth token exchange without a proxy?**

Request body: visible in DevTools → Payload tab (or HAR `postData.text`) as long as DevTools was open. Response body: only guaranteed if you capture with net-export `Include raw bytes`, OR if you add a `beforeunload` breakpoint and inspect before navigation completes. There is no DevTools setting that makes Chrome reliably preserve response bodies across navigations — this is a known longstanding limitation (Chromium issue #141129, open since 2012).

**Q: What does `net_error = -3` mean in a net-export event?**

`-3` is `ERR_ABORTED`. This is the standard "user action or browser logic aborted this load" code. It does NOT mean a network error — the connection was fine up to that point. Common causes: navigation, AbortController, extension block, CSP enforcement. For the full error code list: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h

---

## Reference links

- Chrome DevTools Network Reference: https://developer.chrome.com/docs/devtools/network/reference
- NetLog design document: https://www.chromium.org/developers/design-documents/network-stack/netlog/
- How to capture a NetLog dump: https://www.chromium.org/for-testers/providing-network-details
- Analyzing NetLog JSON (textslashplain): https://textslashplain.com/2020/04/08/analyzing-network-traffic-logs-netlog-json
- NetLog Viewer (online): https://netlog-viewer.appspot.com
- Crash course in net-internals: https://chromium.googlesource.com/experimental/chromium/src/+/refs/tags/83.0.4089.2/net/docs/crash-course-in-net-internals.md
- HAR 1.2 spec: http://www.softwareishard.com/blog/har-12-spec/
- CORB for developers: https://chromium.org/Home/chromium-security/corb-for-developers/
- CORB explainer (Chromium source): https://chromium.googlesource.com/chromium/src/+/master/services/network/cross_origin_read_blocking_explainer.md
- CORP (MDN): https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cross-Origin_Resource_Policy
- Brave Shields: https://brave.com/shields/
- Brave fingerprinting protections: https://github.com/brave/brave-browser/wiki/Fingerprinting-Protections
- Chrome error codes list: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
- Chromium issue #141129 (response body missing after navigation): https://bugs.chromium.org/p/chromium/issues/detail?id=141129
