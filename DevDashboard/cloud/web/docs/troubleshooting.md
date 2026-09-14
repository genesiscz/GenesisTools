# Troubleshooting

The most common failure modes for DevDashboard Cloud (the web app) and their fixes. Most are
configuration issues, not bugs — the app deliberately boots and degrades gracefully when optional
integrations are unconfigured.

> All commands run from `DevDashboard/cloud/web/`. See the
> [README](../README.md#environment) for the full env-var reference.

---

## Signup 500 / "no such table: user"

**Symptom:** the first sign-up returns a 500; logs show `no such table: user` (or `account`).

**Cause:** Better-Auth's Drizzle adapter writes to the `user`/`account` tables directly and does
**not** auto-create them. Domain migrations only run on first cloud-store access, so an unmigrated DB
500s on the very first auth write.

**Fix:** apply the migrations before the first sign-up.

```bash
bun run db:migrate
```

This creates all eight tables (4 Better-Auth + 4 domain) and makes signup → session → dashboard work.
A pointed-at `:memory:` DB will reproduce this on every boot, which is exactly why it isn't used —
always point at a real file (default `./data/cloud.db`).

> The e2e suite handles this for you: its global-setup migrates a throwaway test DB
> (`./.e2e/cloud-e2e.db`) before Playwright's web server starts.

---

## Billing shows "not configured"

**Symptom:** the Billing page shows your tier as `free` and a "Billing is not configured" / demo
state; clicking **Upgrade to Pro** shows a note instead of a Stripe checkout:

> *Stripe is not configured (STRIPE_SECRET_KEY unset). Checkout is disabled in this environment.*

**Cause:** Stripe is optional and inert without keys — the server boots and the page renders, but no
real checkout is possible.

**Fix:** set the Stripe vars in `.env` and restart:

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_TEAM_MONTHLY=price_...
```

- If `STRIPE_SECRET_KEY` is set but the price for a tier is missing, the note becomes *"No Stripe
  price id configured for the `<tier>` tier"* — set the matching `STRIPE_PRICE_*` var.
- The webhook at `/api/stripe/webhook` answers `{ received: true, configured: false }` with a 200
  while unconfigured (a healthy ack), so Stripe's endpoint check passes even before you wire keys.

---

## Subdomain stuck in "demo mode"

**Symptom:** claiming a managed subdomain succeeds and reserves `your-name.devdashboard.app`, but the
wizard shows:

> *Cloudflare for SaaS is not configured (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID unset). This
> subdomain is reserved in your account but not yet live on the edge.*

**Cause:** Cloudflare-for-SaaS provisioning is optional. Without credentials the app synthesizes a
real-shaped result (so the wizard and DB flow are fully exercisable) but provisions nothing upstream.

**Fix:** set the Cloudflare vars in `.env` and restart:

```bash
# An API token scoped to the managed zone with "SSL and Certificates: Edit" + "DNS: Edit"
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CLOUDFLARE_FALLBACK_ORIGIN=fallback.devdashboard.app
DD_CLOUD_MANAGED_DOMAIN=devdashboard.app
```

Once configured, a claim registers a real custom hostname under the managed zone and returns the
routing target your tunnel CNAMEs to.

> **Invalid subdomain name?** Names must be 3–32 **lowercase** letters, digits, or hyphens (and may
> not start/end with a hyphen). `A_B C!` is rejected inline before any API call.

---

## "You already have a managed subdomain"

**Symptom:** claiming a second subdomain throws `You already have a managed subdomain: <hostname>`.

**Cause:** one managed subdomain per account by design.

**Fix:** use the existing one shown in the message, or contact the operator to release it.

---

## Port 7251 already in use

**Symptom:** `bun run dev` fails to bind, or an unexpected app answers on
<http://127.0.0.1:7251>.

**Fix:** find and stop whatever holds the port, or run on another one:

```bash
lsof -nP -iTCP:7251 -sTCP:LISTEN     # see what's holding it
```

To change the port, edit the `dev` script in `package.json` (`--port 7251`). Note the Playwright
config also expects 7251 — keep them in sync, or set `reuseExistingServer` for local iteration.

---

## SQLite WAL sidecar files

**Symptom:** you see `cloud.db-wal` and `cloud.db-shm` next to your DB file.

**Cause:** SQLite runs in WAL mode (write-ahead log) for concurrency — these are normal sidecars,
not corruption.

**Notes:**

- They are gitignored (`*.db-shm`, `*.db-wal`) — never commit them; they contain account data.
- To clean up *test* artifacts only, the e2e global-setup removes `./.e2e/cloud-e2e.db{,-wal,-shm}`
  before each run. **Never** delete or reset your dev/prod DB to "clean up" — the WAL files are part
  of a live database.

---

## Dashboard pages look empty right after load

**Symptom:** a quick `curl` of `/dashboard` shows almost no content.

**Cause:** the dashboard's content is client-rendered; the SSR HTML is minimal by design.

**Fix:** view it in a real browser (or Playwright). This is expected, not a bug — don't assert on
raw curl HTML.

---

## `routeTree.gen.ts` missing on a fresh clone

**Symptom:** type errors or import failures about `routeTree.gen` right after cloning.

**Cause:** the route tree is generated by TanStack Router on the first `dev`/`build`; it's gitignored.

**Fix:** just run `bun run dev` (or `bun run build`) once — it generates the file automatically.

---

## "close timed out" warning during tests

**Symptom:** a benign `close timed out` warning from better-sqlite3's native teardown after Vitest.

**Cause:** native module teardown timing; the exit code is still `0`.

**Fix:** none needed — it's a warning, not a failure. Don't let it gate CI.

---

## Still stuck?

- Check the day-stamped logs and the [README](../README.md) for the relevant env var.
- For agent/pairing problems (not the web app), see [Install the Agent](./install-the-agent.md).
- For "what can the cloud see?" questions, see [Security & Trust](./security-and-trust.md).
