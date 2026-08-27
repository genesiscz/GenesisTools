# Auth / SSO failure playbook

Worked case: a corporate SSO portal, 2026-07-28. Same browser, same root cause, two
symptoms: UAT looped forever, PROD ended on a generic error page.

## Shape of an OIDC federation chain

```
app  ->  IdP /oauth2/authorize            (client_id, redirect_uri=app/auth-callback, state, PKCE)
     ->  upstream SSO /oidc/authorize     (redirect_uri=IdP/commonauth, its own state)
     ->  upstream /login                  (SSO cookie present => auto ticket, no form)
     ->  upstream /oauth2.0/callbackAuthorize?ticket=ST-...
     ->  IdP /commonauth?code=...&state=...        <-- the hop that must carry code+state
     ->  app /auth-callback?code=...&state=...
     ->  app POSTs /token, done
```

Read the chain top-down and find the FIRST hop whose `Location` is not what the next
step needs. That hop is the bug; everything after is fallout.

Two observed failure modes of the same broken hop:

| `callbackAuthorize` 302 Location | Symptom |
|---|---|
| back to the app URL (a URL stored in an old server session) | app sees itself unauthenticated, retries authorize, infinite loop |
| bare `IdP/commonauth`, no `code`, no `state` | IdP cannot correlate → `retry.do` → generic error page |

## Distinguishing the layers

- App/frontend blamed? Check whether ANY frontend code runs between the ticket and the bad
  redirect. If the bad `Location` comes from a raw 302 between two backend endpoints, no
  frontend branch can cause it. State that plainly with the evidence line.
- IdP down? Probe it directly: `curl -so /dev/null -w '%{http_code}' https://idp/commonauth`.
  A 302 means alive; the handoff is what is broken.
- Only one user? Compare against a fresh profile immediately (see SKILL.md step 3).

## Cookie-scope regression (the actual root cause here)

A server changed its session cookie scope (`path=/cas` host-only → `path=/` `domain=.host`)
without expiring the old ones. Browsers alive across the change send BOTH. Longer path
first → container binds the stale session → the OAuth transaction is missing from it →
the callback has nothing to append.

Fingerprint in a cookie dump: same cookie NAME twice, different `path`, one host-only.
Fresh profiles only ever get the new scope, which is why it never shows in testing.

Server fix to recommend:

```
Set-Cookie: JSESSIONID=; Path=/cas; Max-Age=0        (host-only, no Domain attribute)
Set-Cookie: <other legacy names>=; Path=/cas; Max-Age=0
```

plus: the callback should emit an OAuth `error=` redirect when its request context is
missing, instead of silently bouncing to a stored URL.

User workaround: delete the stale `path=/cas` cookies, or fully quit the browser
(they are session cookies).

## Repro honesty

Injecting fabricated stale cookies into a healthy profile did NOT reproduce it: the
container ignores unknown session ids, and CAS-signed artifacts (`TGC`, delegation JWT)
cannot be forged client-side. Reliable repro is server-side (create a session under the
old scope, redeploy the new scope, log in with both present). Report a failed injection
as inconclusive, never as "the theory is wrong".
