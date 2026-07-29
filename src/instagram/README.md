# instagram

Inspect public Instagram profiles anonymously, and fetch story / highlight media with **your own** session cookie.

```bash
tools instagram profile <username>              # public info — no session needed
tools instagram highlights <username>           # highlight ids + titles — no session needed
tools instagram stories <username>              # story media — session required
tools instagram highlight <username> <id>       # one highlight's media — session required
tools instagram session                         # show how the cookie is being resolved
```

Add `--json` to any read command for machine output, and `-d [dir]` to `stories` / `highlight` to download the media.

## What needs a session and what does not

| Data | Session | Endpoint |
|---|---|---|
| Profile fields, follower/post counts, bio, privacy flag | no | `/api/v1/users/web_profile_info/` |
| Whether a live story exists + when it expires | no | legacy `query_id` reel endpoint |
| Highlight ids, titles, covers | no | legacy `query_id` reel endpoint |
| Story items (the actual media) | **yes** | `/api/v1/feed/reels_media/` |
| Highlight items (the actual media) | **yes** | `/api/v1/feed/reels_media/` |

The split is the whole point of the tool. Instagram gates story *media* on viewer identity, but story *existence* and the highlight tray are genuinely public.

## The empty-result trap

Instagram answers an unauthenticated story request with **HTTP 200 and `{"reels":{}}`** — never a 401. So "there are no stories" and "you are not allowed to see them" are identical on the wire.

This tool therefore **refuses** rather than reporting an empty result: no session means an error explaining why, and an empty reel map *with* a session is reported as an expired cookie. Silently printing "no stories" for a gated response is the single most misleading thing it could do, and it is what most wrappers around this API get wrong.

## Supplying the session cookie

The cookie is a live credential to a real account, so it is **never written to config**. Only the *name* of an environment variable is stored, mirroring the `tokens.apiKeyEnv` convention used by the AI accounts.

```bash
export IG_SESSIONID="<sessionid cookie from your browser>"
export IG_CSRFTOKEN="<csrftoken cookie>"      # optional but recommended, see below
```

Resolution order: `--session-cookie` flag → `IG_SESSIONID` / `INSTAGRAM_SESSIONID` → the variable named by `tools instagram session --use-env NAME`. Any of them accepts a bare value or a whole pasted `csrftoken=…; sessionid=…` string.

Instagram pairs the `csrftoken` cookie with the `sessionid` it was issued alongside, and expects the `x-csrftoken` header to carry the same value. So a csrftoken has to travel *with its own* session:

- `IG_SESSIONID` + `IG_CSRFTOKEN` are treated as a pair, since both come from the environment together.
- `--session-cookie` does **not** borrow `IG_CSRFTOKEN`. The flag exists to override the environment's session, and attaching that session's token to a different cookie would manufacture exactly the mismatch this warns about. Paste the full cookie string, or pass `--csrf-token` to supply one that belongs with it.

The client logs a warning on every request that goes out with no csrftoken at all.

> **Use a throwaway account.** Reading stories this way violates Instagram's ToS, and it puts you in the story's viewer list exactly as the app would.

## Rate limiting

Proactive, not reactive: a **75-request / 11-minute** budget with instaloader's per-request jitter (`min(expovariate(0.6), 15)` seconds), taken from `instaloader/instaloadercontext.py`. A budget refuses the request *before* it is sent, so that request never becomes a strike — unlike a flat delay plus backoff-on-429, which only tells you that you were too fast after Instagram has already counted it.

> ⚠️ **The budget is per process and is not persisted.** `tools` runs each invocation in its own process, so ten commands in a row each start with a full 75, and back-to-back runs can exceed the window that any single run respects. Treat it as an invocation-local throttle, not an account-wide guarantee. Making it account-wide needs the timestamps in the tool's storage dir behind an inter-process lock.

Media downloads run sequentially for the same reason. They go to the pre-signed CDN with no cookie attached, but they share the egress IP, and a burst is the cheapest way to earn an IP-level block.

## Error kinds

Failures are classified rather than dumped, because the right response differs sharply per kind:

- `session-required` / `session-invalid` — no cookie, or Instagram rejected the one supplied
- `checkpoint` — account-level flag. **Rotating IP or proxy makes it worse.** Clear it in a browser
- `suspended` — challenge URL contained `/suspended/`; an SMS code will not fix it, it needs an appeal
- `feedback-required` — "that looked automated", scored against the **account**; backing off does not clear the current block
- `please-wait` — arrives as HTTP 401 with `require_login: true` but your cookie is fine; caller-scoped, only time clears it
- `rate-limited` — IP-level (`sentry_block`, `rate_limit_error`, 429); backing off genuinely helps
- `not-found`, `network`

Enforcement markers are only read inside a response Instagram itself failed (4xx, or a `"status":"fail"` envelope). Scanning every body would turn a bio containing the word "spam" into a fabricated account block.

## Privacy notes

- The anonymous endpoints take no `sessionId` parameter, and go through `getAnonymousJson`, whose options type sets `sessionId?: never` — passing one is a compile error, not a code-review catch. instagrapi's `inject_sessionid_to_public()` silently injects real credentials into "public" calls when an anonymous one fails; that class of leak is unrepresentable here.
- The `x-ig-www-claim` token is replayed per auth mode. Echoing the claim Instagram minted for your logged-in session on a later anonymous request would hand it the link between the two.
- The cookie is never logged and never persisted. `tools instagram session` prints only its first 6 characters (the leading digits of the numeric user id) and its length.
