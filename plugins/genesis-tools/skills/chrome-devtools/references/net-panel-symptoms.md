# Network panel: what the columns actually mean

Covers `(unknown)` Type, every Status value (`(canceled)`, `(blocked:origin)`,
`(blocked:other)`, `(failed)`, XHR status 0), Size/Initiator oddities, and why a response
body is missing or empty. Read when the panel says something you cannot reconcile with
what the server did.

**The single most load-bearing fact:** Chrome does not stream response body bytes to
DevTools until you actively view them, and a navigation destroys the in-memory copy. A
missing body is usually THIS, not the server. See 2.1. For an OAuth/token POST killed by a
navigation, go straight to 2.6.

Further: `net-capture-settings.md` (get more out of the browser) ·
`net-export-recipes.md` (see below HTTP) · `SKILL.md` trigger table.

---

## 1. Why `(unknown)` appears, exhaustively

### 1.1 Type column

The Type column shows the MIME type derived from the `Content-Type` response header, after sniffing is applied. It shows `(unknown)` in the following situations:

| Cause | Mechanism | What You See |
|-------|-----------|--------------|
| **No `Content-Type` header** | Chrome has no declared type and sniffing fails or is disabled (`X-Content-Type-Options: nosniff` present) | `(unknown)` |
| **Unrecognised MIME type** | e.g. `application/x-custom-type` with a non-standard subtype not in Chrome's MIME registry | `(unknown)` or the raw string |
| **Service worker short-circuit** | SW intercepts with `respondWith()` and synthesises a `Response` object with no `Content-Type` set | `(unknown)`, Initiator shows `ServiceWorker` |
| **Prefetch / preload cache hit** | Resource served from the prefetch cache before headers were inspected | `(unknown)` or `Other` |
| **Opaque response (no-cors)** | Cross-origin fetch in `mode: 'no-cors'` — CORB/ORB strips the content-type | `(unknown)` in Type; size column may also be `0 B` |
| **`data:` URL** | Chrome doesn't classify these into a named MIME bucket unless the prefix is a common type | `(unknown)` or `text/plain` |

**Primary source:** Chrome DevTools network reference — https://developer.chrome.com/docs/devtools/network/reference

### 1.2 Status column: values and causes

The Status column is not just an HTTP status code. It carries a rich vocabulary:

| Displayed value | Meaning |
|----------------|---------|
| `200`, `301`, `401` … | Normal HTTP status. |
| `(canceled)` | Chrome aborted the request **before** a response arrived. See §1.2.1 for causes. |
| `(failed)` + error message | Network-level error (DNS failure, TLS handshake failure, RST from server, etc). |
| `(blocked:origin)` | CORB / ORB blocked the cross-origin response. Hover for a tooltip. |
| `(blocked:other)` | Browser extension (uBlock, Brave Shields, Privacy Badger) or a CSP / mixed-content enforcement blocked it at the network layer, **before** it reached the server. The request was never sent. |
| `(blocked:devtools)` | You manually blocked the URL via the Network request blocking panel (DevTools drawer). |
| `(failed) net::ERR_BLOCKED_BY_CLIENT` | Same as `(blocked:other)` at the net layer — extension intercepted. |
| `(failed) net::ERR_BLOCKED_BY_RESPONSE` | `Cross-Origin-Embedder-Policy` or `Cross-Origin-Opener-Policy` rejected the response after arrival. |
| `CORS error` | Pre-flight failed or the actual response lacked the required `Access-Control-Allow-*` header. |
| **Status 0** | The request was aborted **client-side** before any HTTP response was received. This is the XHR/fetch representation of a connection that was torn down. Common causes: `fetch().abort()` / `AbortController`, navigation happened while the request was in-flight, CSP block, mixed-content block, SW `event.respondWith()` throwing. In the Network panel this renders as `(canceled)` or `(failed)`, never as a literal `0` in the Status column — but XHR's `readyState === 4` with `status === 0` maps to this same condition. |

#### 1.2.1 `(canceled)` causes in detail

Source: chromium.org crash-course, SO thread https://stackoverflow.com/questions/12009423/

- The DOM element that triggered the load was **removed** before the response arrived (e.g. an `<img>` node deleted, an `<iframe>` src changed or the iframe removed, a React component unmounted).
- **Navigation** happened (user clicked a link, JS set `window.location`, form `<button>` submitted the parent form simultaneously with an XHR click handler — missing `event.preventDefault()`).
- **`AbortController.abort()`** was called, or jQuery/axios/RxJS `switchMap` cancelled in-flight requests.
- **JS timeout** (axios `timeout`, jQuery `$.ajax({timeout: …})`) expired.
- A redirect crossed the **https→http** boundary inside an iframe (mixed content: a secure page must not load insecure content).
- **X-Frame-Options: DENY** or **SAMEORIGIN** caused a framed load to be cancelled silently.
- **TLS certificate mismatch** — Chrome silently auto-redirected to the canonical domain and cancelled the original.
- A **malformed redirect URL** (`Location:` header was invalid or contained a relative path that Chrome couldn't resolve).
- Font: Chrome cancels **ttf/woff** requests when it already has a **woff2** version of the same font.
- Multiple redundant `onclick` + `href` triggers firing simultaneously (double-loading).
- **Extension** (uBlock, Privacy Badger, Brave Shields, JavaScript Errors Notifier, Hola) injected a `webRequest.onBeforeRequest` block.
- **Many requests to the same host** when earlier ones returned DNS failures.

### 1.3 Size column

The Size column has two values in big-row mode (Settings → Big request rows): top = transferred size (compressed, over wire), bottom = uncompressed resource size. In normal mode only the transferred/cache annotation is shown.

| Displayed value | Meaning |
|----------------|---------|
| `(memory cache)` | Response was served from the **in-process memory cache** (MemoryCache in Blink). Zero bytes transferred over the wire. Typical for resources fetched multiple times on the same page. |
| `(disk cache)` | Response was served from the **on-disk HTTP cache** (CacheStorage / HTTP Cache). Zero bytes transferred. |
| `(prefetch cache)` | Resource was preloaded via `<link rel="prefetch">` or the Speculation Rules API and served from the prefetch cache. Zero bytes transferred at this point. |
| `(service worker)` | Response was synthesised or retrieved by a service worker and handed to the page without hitting the network. The SW's `respondWith()` can return a cached Response or a fabricated one. |
| `(from preloaded response)` / `(push)` | HTTP/2 server push or `<link rel="preload">` early hints — the response was already buffered. |
| `0 B` (numeric) | Either the server sent no body (204 No Content, 304 Not Modified, intentional empty body), or the server DID send one and CORB/ORB stripped it before the renderer saw it — the note below tells the two apart. |

**Note on CORB/ORB:** When Cross-Origin Read Blocking fires, Chrome replaces the response body with an **empty body** and injects a `0 B` transferred size. The original `Content-Length` header remains in the panel (the server did send bytes, Chrome just discarded them). This is why you can see `Content-Length: 1126` alongside `(empty)` body in the Response tab — the bytes arrived, Chrome stripped them as opaque.

Source: https://chromium.googlesource.com/chromium/src/+/master/services/network/cross_origin_read_blocking_explainer.md

### 1.4 Initiator column: `(other)` and empty

| Displayed value | Cause |
|----------------|-------|
| **Parser** | Injected from the HTML parser (`<script src>`, `<img src>`, `<link href>`). |
| **Script** + stack trace | Initiated by JS. Hover to see the call stack. |
| **Redirect** | HTTP 301/302/307/308 redirect. |
| **(other)** | Triggered by browser internals that are not attributable to a specific script or HTML element. Common: browser startup, extension requests, service worker internal fetches, preconnect attempts, OCSP stapling, CRL fetches, speculative preconnects. |
| **Empty** | Request happened before DevTools was open and the initiator metadata was not captured. |

### 1.5 HAR export vs. live panel

The HAR format (spec: http://www.softwareishard.com/blog/har-12-spec/) drops or degrades the following data compared to what is live in the panel:

| Data | Live panel | HAR export |
|------|-----------|------------|
| Response body | Present if viewed before navigation | Present only if "Save all as HAR **with content**" was chosen AND body was loaded into DevTools memory |
| Request body bytes | Full | `postData.text` or `postData.params` (spec supports it but Chrome's sanitised export may omit it) |
| Cookie / Authorization headers | Shown | Stripped in the **sanitised** variant; included in "with sensitive data" |
| Timing phases | Full (ms resolution) | Preserved but precision varies |
| Initiator stack trace | Shown in column | Not in HAR 1.2 spec; Chrome adds it as a custom `_initiator` field |
| Connection reuse info | Shown via Connection ID column | `connection` field (string, not always populated) |
| `(memory cache)` / `(disk cache)` tag | Shown | `cache.beforeRequest` / `cache.afterRequest` objects, but often empty `{}` |
| Websocket frames | Shown in Messages tab | Not in HAR 1.2; Chrome omits them |
| Response body for CORB-blocked requests | `(blocked)` shown | `response.content.size: 0`, `text: ""` |

---

## 2. Why the response body is missing or empty (even with Preserve log on)

### 2.1 Chrome's "low overhead" policy, the root cause

Chrome DevTools uses a **lazy transfer** model: response bytes are **not** sent from the renderer/network process to the DevTools front-end until you **explicitly click on a request and view the Response tab**. This is documented in Chromium bug #141129 (2012, open as of 2024):

> "This is an outcome of 'low overhead' policy — resource content isn't transferred to DevTools until user explicitly wants to view it."
> — Chrome developer Eustas, https://bugs.chromium.org/p/chromium/issues/detail?id=141129

Consequence: if a navigation happens (including a redirect, a `window.location` change, or the page reloading) before you clicked the Response tab, the in-memory copy is discarded. `Preserve log` keeps the **request/response metadata** (headers, timing, URL, status) across navigations but **not the response body bytes** — those are already gone.

This is NOT fixed as of Chromium 151 (verified live on Brave, 2026-08). Workarounds:

1. Set a **beforeunload breakpoint** in Sources → Event Listener Breakpoints → Load → beforeunload, then inspect the response before the breakpoint resumes.
2. Use **Firefox**, which does preserve response bodies across navigations.
3. Use a proxy tool (Charles, Fiddler, mitmproxy) that sits outside the browser's memory model.
4. Use `chrome://net-export/` with `Include raw bytes` enabled — this captures bodies at the network process level, before the renderer sees them.

Source: https://superuser.com/questions/1788537/

### 2.2 Response body size cap

Chrome DevTools has a per-response body size limit. In Chrome/Brave, responses larger than approximately **64 MB** are truncated. In the HAR export, the `response.content.text` field will be cut off mid-stream with no warning in the HAR itself. The `response.content.size` field still reflects the real (untruncated) size.

Firefox has a configurable limit via `devtools.netmonitor.responseBodyLimit` (default 1 MB, set to 0 for unlimited). Chrome does not expose this setting in DevTools UI — the only workaround is `chrome://net-export/` with raw bytes.

### 2.3 Streaming responses

If the server sends a streaming response (chunked transfer-encoding with an open connection, SSE, or a large body that is still arriving), and you export the HAR or navigate away, the body captured in the HAR will be whatever arrived up to that moment. The `content.size` will be the partial size.

### 2.4 Service worker intercept

When a service worker intercepts a fetch and calls `event.respondWith(cachedResponse)`, the response body is delivered directly from the SW to the page's renderer. The network process never sees the bytes. DevTools shows the request with `(service worker)` in the Size column, and the Response tab often shows `(no response data)` or an empty body — because the SW synthesised the response from its own CacheStorage, which is a separate process.

The only way to inspect the body in this case is:
- Application → Cache Storage → inspect the cached entry.
- In the SW DevTools (Sources → Service Workers), intercept via `respondWith()` logging.

### 2.5 CORB / CORP / CORS opaque response body stripping

When Cross-Origin Read Blocking (CORB) or its successor Opaque Response Blocking (ORB) fires, Chrome:
1. Receives the full response bytes from the server.
2. **Replaces the body with an empty body** before delivering to the renderer.
3. Keeps the original HTTP headers (including `Content-Length`) intact in the panel.

Result: DevTools shows `Content-Length: 1126` in headers but `(empty)` in the Response tab and `0 B` transferred in the Size column. The CORB decision is logged to the DevTools Console as:

```
Cross-Origin Read Blocking (CORB) blocked cross-origin response https://… with MIME type text/html.
```

CORB applies to cross-origin responses with HTML, JSON, or XML MIME types loaded by `<script>`, `<img>`, etc. in `no-cors` mode. It does NOT apply to same-origin requests or to requests with proper CORS headers.

Source: https://chromium.org/Home/chromium-security/corb-for-developers/

**CORP** (`Cross-Origin-Resource-Policy` response header) is a server-opt-in equivalent: when `Cross-Origin-Resource-Policy: same-origin` is set and a cross-origin request arrives, the browser strips the body after receiving it. The MDN description: "the browser prevents the result from being leaked by stripping the response body" — https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cross-Origin_Resource_Policy

### 2.6 Navigation aborts an in-flight fetch: the OAuth token-endpoint pattern

This is the canonical cause for Martin's CEZ OAuth issue:

1. Page A makes a `POST /token` with `Content-Type: application/x-www-form-urlencoded`.
2. Before the response body arrives (or before you click the entry in DevTools), the server issues a `302` redirect or JS sets `window.location` to complete the OAuth callback.
3. Navigation destroys the renderer process's copy of the in-flight response.
4. HAR shows: headers including `Content-Length: 1126`, status `200`, but `response.content.text: ""` and `response.content.size: 0` (or the correct size with empty text).

The `Content-Length: 1126` is real — the server did send that many bytes. Chrome's network process received them. But the DevTools UI never got them transferred because the navigation happened first.

**Fix:** Use `chrome://net-export/` with `Include raw bytes`. The net-export capture happens at the network process level and is not affected by renderer navigation. Decrypted plaintext lands in `SSL_SOCKET_BYTES_RECEIVED` events (`SOCKET_BYTES_RECEIVED` is the encrypted wire layer; QUIC/HTTP3 traffic logs `QUIC_SESSION_*` packet events instead, which the viewer does not reassemble into bodies).

### 2.7 Content-Encoding mismatch

If the server sends `Content-Encoding: gzip` but the body is not valid gzip, Chrome's decompressor will fail. The Response tab shows an error or empty content. The HAR body will be empty. The Size column shows the raw wire bytes (the garbage gzip). The `Content-Length` header shows what the server claimed.

### 2.8 `Cache-Control: no-store` and bfcache

When a page is stored in the Back/Forward Cache (bfcache) and the response had `Cache-Control: no-store`, the bfcache entry is still created (bfcache operates at the rendering layer, separate from the HTTP cache). However, if DevTools was not recording when the page was first loaded, bfcache restores will not re-emit network events to DevTools. You see the page appear but nothing in the Network panel — `Preserve log` does not help here because no new network events are generated.

To force a real network request (bypassing bfcache): hold Shift while clicking the refresh button, or open DevTools → Application → Back/Forward Cache and use the "Test back/forward cache" tool.

---
