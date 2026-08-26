# CDP recipes

The cdp lib mirrors the chrome-devtools-mcp tool surface as importable functions. For a
scratch script, don't hand-write the boilerplate. Scaffold it into the scripts store:

```bash
tools chrome-devtools scaffold myProbe --recipe redirect-chain
tools scripts run myProbe -- --port 9222 --match idp.example.com
```

Scaffolded scripts import the lib as `@gt/chrome-devtools/cdp`. Inside this repo, import
`src/chrome-devtools/lib/cdp.ts` directly. The full API is in `cdp-cheatsheet.md`.

## Record a redirect chain while it happens

```ts
import { attach } from "@gt/chrome-devtools/cdp";

const page = await attach({ port: 9222, url: "example.com" });
const events = page.recordNetwork((u) => /example|idp/.test(u));
await page.navigate("https://example.com/app");
await Bun.sleep(15000);
for (const e of events) {
    if (e.kind === "redirect") console.log(e.status, e.from, "->", e.location);
    if (e.kind === "nav") console.log("NAV", e.url);
}
```

`recordNetwork` keeps `redirectResponse` hops (status, from, `Location`, `Set-Cookie`). A
flat request list drops them, and that is where auth bugs live. Usually you don't need the
script at all anymore: with a recorder running, `tools chrome-devtools har --last 10m` has
the same hops retroactively.

## Cookie diff: broken browser vs fresh profile

The `cookie-diff` recipe is this, ready to run. The core:

```ts
const key = (c) => `${c.name}|${c.domain}|${c.path}`;
const [a, b] = await Promise.all([browser(9222), browser(9223)]);
const [A, B] = await Promise.all([a.cookies("idp.example.com"), b.cookies("idp.example.com")]);
const mapB = new Map(B.map((c) => [key(c), c]));
for (const c of A) {
    if (!mapB.has(key(c))) console.log("BROKEN-ONLY", key(c), "httpOnly=" + c.httpOnly, "len=" + c.value.length);
}
```

Duplicate name across paths means the longer path is sent first (RFC 6265) and a stale
session wins. `tools chrome-devtools cookies` flags duplicates without any script.

## Surgical cookie deletion

```bash
tools chrome-devtools rm-cookie --name JSESSIONID --domain idp.example.com --path /legacy
```

Delete ONE suspect at a time and re-run the flow between deletions. That isolates the
culprit. Never wipe all site data: it destroys the evidence and the user's logins.

## Storage snapshot

```bash
tools chrome-devtools eval '() => ({
  url: location.href,
  ls: Object.fromEntries(Object.entries(localStorage).map(([k, v]) => [k, String(v).slice(0, 120)])),
  ss: Object.fromEntries(Object.entries(sessionStorage).map(([k, v]) => [k, String(v).slice(0, 120)])),
})'
```

Growing families of per-attempt keys (dozens of `*_appauth_authorization_request`) mean a
client retry loop with no circuit breaker. A real finding, but usually a symptom, not the
cause.

## Decode a JWT-shaped cookie without printing secrets

```ts
const payload = (tok: string) => {
    const p = tok.split(".")[1];
    return JSON.parse(Buffer.from(p + "=".repeat((4 - (p.length % 4)) % 4), "base64url").toString());
};
```

A nested/encrypted JWE (5 segments) will not decode. Say so instead of guessing at its
contents.

## Fetch a response body

Bodies die when the tab navigates, so grab them while the request is fresh:

```bash
tools chrome-devtools har --now --reload -o /tmp/cdp.har     # bodies of a fresh load
tools chrome-devtools scaffold apiBodies --recipe body-fetch # bodies of matching XHRs, live
```

Or start the recorder with the body channel: `record --match app.example.com --channels +body`
(2 KB cap per body).

## Browsing history: when the loop happened, how many times

The `History` SQLite DB proves *when* a user hit a bug and how often. Visit volume per day
exposes retry loops that a single HAR cannot. It never contains cookies or headers, so it
dates an incident, it does not explain one.

```bash
cp "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/Default/History" /tmp/hist.db
# Chrome: ~/Library/Application Support/Google/Chrome/Default/History
# ALWAYS copy. The live file is locked by the running browser.

# Loop detection: visits per day to the auth host. A clean login touches /cas 2-3x;
# hundreds means the flow was looping.
sqlite3 /tmp/hist.db "
SELECT date(v.visit_time/1000000 - 11644473600,'unixepoch','localtime') d, COUNT(*) n
FROM visits v JOIN urls u ON u.id = v.url
WHERE u.url LIKE '%idp.example.com/cas%'
GROUP BY d ORDER BY d;"
```

🛑 **`strftime('%s', …)` returns TEXT, so `<integer epoch> BETWEEN strftime(...) AND
strftime(...)` is ALWAYS FALSE.** SQLite compares storage classes before values: every
INTEGER sorts below every TEXT. The query returns 0 rows and no error, which reads exactly
like "the user never visited that site". That wrong conclusion has been drawn once already.
Verified 2026-08-10: identical query, 0 rows without the cast, 774 with it.

```bash
# ❌ silently 0 rows, always
WHERE v.visit_time/1000000 - 11644473600
      BETWEEN strftime('%s','2026-07-28 00:00:00') AND strftime('%s','2026-07-28 23:59:59')

# ✅ cast both bounds
WHERE v.visit_time/1000000 - 11644473600
      BETWEEN CAST(strftime('%s','2026-07-28 00:00:00') AS INTEGER)
          AND CAST(strftime('%s','2026-07-28 23:59:59') AS INTEGER)

# ✅ better: compare rendered datetimes, no epoch arithmetic, timezone explicit
WHERE datetime(v.visit_time/1000000 - 11644473600,'unixepoch','localtime')
      BETWEEN '2026-07-28 00:00:00' AND '2026-07-28 23:59:59'
```

Prefer the third form. Two more traps in the same family:

- Epoch base. Chromium `visit_time` is microseconds since 1601-01-01 (WebKit epoch), not
  Unix. Subtract `11644473600` after dividing by 1e6. `downloads.start_time` and
  `cookies.expires_utc` use the same base.
- Timezone. `'localtime'` renders local, `strftime('%s', …)` parses as UTC. Mixing them
  shifts results by your offset. Pick one and state it in the output.

Always sanity-check a zero. Before reporting "no visits in that window", re-run the same
query grouped by day with no time filter. If rows exist there but not in the window, the
filter is broken, not the data.

## Gotchas

- Attach BEFORE the action. Live recorders start empty and bodies reset per navigation.
  The background recorder (`attach` starts it) is the cure for "I attached too late".
- A 0-row SQL result is a claim, not a fact. Prove the filter works before concluding
  absence.
- `--user-data-dir` is what makes `open -na` start a SECOND instance. Without it macOS
  focuses the running app and silently drops the flags.
- Launching a browser under CDP that is already running with the same profile: flags
  ignored, no endpoint. Check with `attach` right after `open`.
- CDP on localhost lets any local process drive a logged-in browser. Tell the user, and
  remind them to relaunch without the flag when done.

## The standard live-bug loop

```bash
tools chrome-devtools attach                       # starts the recorder
tools chrome-devtools follow --channels nav,redirect,error,cookie \
  --match idp.example.com --out /tmp/auth.log      # run with run_in_background: true
```

`follow` prints Monitor-ready commands first. Arm one, THEN reproduce. Never `until … sleep`
on the log; that blocks you and duplicates what Monitor already does.

Channel picking, by symptom:

| Symptom | `follow --channels` |
|---|---|
| redirect loop / OAuth dead end | `nav,doc,redirect,cookie` |
| API failing only for this user | `xhr,error,cookie` |
| SPA stuck, blank, spinner forever | `nav,console,error,xhr` |
| realtime feature broken | `ws,error` (recorder needs `--channels +ws`) |
| "what does the server actually return" | `body` (recorder needs `--channels +body`) |
| storage growing per attempt (retry loop) | `nav,storage` (recorder needs `--channels +storage`) |

`--match` takes `/regex/flags` too: `--match '/(idp|auth)\.example/'`.
