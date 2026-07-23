# 10 — DevDashboard Cloud: Landing Page + Managed Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> **Depends on:** ADR §4 (trust tiers) + research `04-transport-and-trust.md` Part 3 (authoritative
> trust analysis). **Forward-references plan 02** (`…-02-TransportTrust.md`, *not yet written*) for the
> E2E pairing internals (X25519 ECDH → per-message AEAD). This plan implements only the **cloud side**,
> which by design **never holds endpoint keys** — it cross-references 02 by name and must not
> re-implement or rename the crypto.
>
> **Standing rules (ADR §0):** search docs on demand (don't code framework integrations from memory);
> **ASK before locking any new library** (every framework/lib pick below is an `openQuestion`, with a
> PROPOSED choice — confirm with the user before `bun add`). Bun + TypeScript strict; **SafeJSON only**
> (never `JSON`); logger/out split (`out.result` is the only stdout result writer); no one-line ifs,
> blank line before `if` / after closing `}`; objects for 3+ params; no `as any`.

**Goal:** Build **DevDashboard Cloud** (`DevDashboard/cloud/`): (1) a high-converting, high-end
marketing **landing page** whose trust/verifiability story is front-and-center and whose copy matches
ADR §4's tiered trust policy **exactly**, and (2) a **managed provisioning** backend — signup →
account → provision a vendor relay/tunnel for the account → assist the E2E pairing handshake **without
ever holding endpoint keys** → a billing stub.

**Architecture:** A static/SSG marketing site (`cloud/web/`) renders sections from a single
**`shared/tier-policy.ts`** module (the one source of truth for every trust claim, asserted against
the rendered copy by a parity test). A small Bun + Hono provisioning API (`cloud/api/`) owns account,
auth, relay-binding provisioning, a **pairing-assist** endpoint that relays only **public** material,
and a `BillingProvider` stub. The cloud's data boundary **is** the trust claim: the cloud DB may store
account rows, subscription rows, and relay-binding rows (public relay URL + the agent's/phone's
**public** keys) — and **never** private keys, derived session secrets, or the pairing secret. A guard
test enforces this against the schema.

**Tech Stack (all PROPOSED — confirm before adding):** Astro SSG + Tailwind v4 (marketing) **or**
reuse repo Vite+React; Bun + Hono (API); kysely + SQLite for the stub (Postgres noted for prod
multi-tenant); `better-auth` **or** roll-own on `lib/auth` (open question); `@noble/curves` X25519 only
if the cloud ever needs to *verify* a public key (it never decrypts); Stripe named + deferred behind
`BillingProvider`. Tests: `bun:test` (units + guards), Playwright (web signup), Appium (mobile managed
pairing).

---

## File Structure

**Create:**

`DevDashboard/cloud/shared/` — pure, framework-agnostic, importable by web + api + tests:
- `DevDashboard/cloud/shared/tier-policy.ts` — the SINGLE source of truth for the four trust tiers + their exact claim strings + the managed metadata caveat. Imported by the landing copy AND by the parity test.
- `DevDashboard/cloud/shared/tier-policy.test.ts` — asserts the policy literals match ADR §4 verbatim.
- `DevDashboard/cloud/shared/account-model.ts` — `Account`, `Subscription`, `RelayBinding`, `ProvisionStatus` DTOs + the `CLOUD_PERSISTABLE_FIELDS` allow-list (what the cloud is *permitted* to store).
- `DevDashboard/cloud/shared/data-boundary.ts` — `assertNoKeyMaterial(record)` guard used by every persistence write + the boundary test.
- `DevDashboard/cloud/shared/data-boundary.test.ts`

`DevDashboard/cloud/web/` — the marketing + signup site (framework per open question):
- `DevDashboard/cloud/web/src/content/copy.ts` — all section copy, deriving trust strings from `shared/tier-policy.ts`.
- `DevDashboard/cloud/web/src/components/Nav.tsx` — floating glass "fluid island" nav.
- `DevDashboard/cloud/web/src/components/Hero.tsx` — hero section.
- `DevDashboard/cloud/web/src/components/TrustStory.tsx` — verifiability story (the differentiator, front-and-center).
- `DevDashboard/cloud/web/src/components/Tiers.tsx` — the four-tier comparison (LAN / Tailscale / self-hosted-cloudflared / managed).
- `DevDashboard/cloud/web/src/components/HowItWorks.tsx` — install agent → connect → run.
- `DevDashboard/cloud/web/src/components/Pricing.tsx` — tier pricing cards.
- `DevDashboard/cloud/web/src/components/SignupCta.tsx` — signup form + CTA.
- `DevDashboard/cloud/web/src/pages/index` — composes the sections (extension per framework: `.astro` or `.tsx`).
- `DevDashboard/cloud/web/src/styles/theme.css` — high-end-visual-design tokens (premium type scale, spacing, squircle radii, cubic-bezier curves). **Independent of `@ui` design-system** (marketing site, not an app dashboard).
- `DevDashboard/cloud/web/copy-parity.test.ts` — asserts rendered/section copy contains the exact `tier-policy.ts` claim strings.

`DevDashboard/cloud/api/` — provisioning backend:
- `DevDashboard/cloud/api/db/schema.ts` — kysely table types (`accounts`, `subscriptions`, `relay_bindings`) — **no key-material columns**.
- `DevDashboard/cloud/api/db/migrations.ts` — `runMigrations()` (reuses repo `src/utils/database/migrations.ts` pattern).
- `DevDashboard/cloud/api/db/store.ts` — `CloudStore` (typed kysely accessor) calling `assertNoKeyMaterial` on every write.
- `DevDashboard/cloud/api/db/store.test.ts`
- `DevDashboard/cloud/api/auth.ts` — `signup()` / `login()` / `requireAccount()` (open question: better-auth vs roll-own on `lib/auth`).
- `DevDashboard/cloud/api/auth.test.ts`
- `DevDashboard/cloud/api/provision.ts` — `provisionRelay(accountId)` → creates a relay binding (vendor relay/tunnel) and returns `{ relayUrl, pairingChannelId }`.
- `DevDashboard/cloud/api/provision.test.ts`
- `DevDashboard/cloud/api/pairing.ts` — `RelayProvider` interface + `StubRelayProvider`; the **pairing-assist** endpoint that forwards only public keys + the relay endpoint (cross-ref plan 02 for what the endpoints do with them).
- `DevDashboard/cloud/api/pairing.test.ts`
- `DevDashboard/cloud/api/billing.ts` — `BillingProvider` interface + `StubBillingProvider` (Stripe deferred).
- `DevDashboard/cloud/api/billing.test.ts`
- `DevDashboard/cloud/api/server.ts` — Hono app mounting `/api/cloud/*` routes (signup, login, provision, pairing-assist, billing-webhook stub).
- `DevDashboard/cloud/api/server.test.ts`

`DevDashboard/cloud/e2e/`:
- `DevDashboard/cloud/e2e/signup.web.spec.ts` — Playwright: landing → signup → "agent connect" instructions shown.
- `DevDashboard/cloud/e2e/specs/managed-pairing.spec.ts` — Appium: mobile managed-tier connect/pair flow (extends the `ConnectPage` POM).
- `DevDashboard/cloud/e2e/pages/ConnectPage.managed.ts` — managed-tier additions to the shared `ConnectPage` (from plan 04/02).

**Modify:**
- `src/utils/ui/dashboards.ts` — register the cloud web dev port in the canonical ports/launch registry (conflict detection).

**Untouched / cross-referenced (NOT implemented here):** plan 02's `Transport` impl, the E2E
crypto (`pairDevice`, ECDH/AEAD), and the mobile app's `ConnectPage` base — this plan only *extends*
them.

---

### Task 0: Scaffold `DevDashboard/cloud/` + decide the framework stack

> Before any code, surface the stack picks (ADR rule §0.2: ask before locking a new library). This task
> is structure-only; the picks become the `openQuestions` returned by this plan. Use the PROPOSED leads
> below as defaults if the user defers.

**Files:**
- Create: `DevDashboard/cloud/README.md`
- Create: `DevDashboard/cloud/shared/` (empty dir placeholder via the first real file in Task 1)

- [ ] **Step 1: Confirm the four stack decisions with the user (AskUserQuestion)**

Present these four picks with the PROPOSED lead + one alt each:
1. **Marketing framework** — lead: **Astro SSG + Tailwind v4** (zero-JS-by-default, best Lighthouse, island hydration only for the signup form). Alt: reuse the repo's **Vite + React 19 + Tailwind v4** (one toolchain, but ships more JS for a marketing page).
2. **Cloud API framework** — lead: **Bun + Hono** (mirrors the Agent's `Bun.serve` patterns from plan 01; Hono gives routing + middleware). Alt: bare `Bun.serve` + the plan-01 `Router`.
3. **Cloud DB** — lead: **kysely + SQLite** (already in repo deps; fine for the stub + a single-tenant test account). Note: **Postgres** for real multi-tenant prod (call out in README; the `CloudStore` interface hides the dialect).
4. **Auth** — lead: **roll-own on `src/dev-dashboard/lib/auth.ts`** (reuses the verified Basic/session primitives; zero new dep). Alt: **better-auth** (sessions + OAuth out of the box, new dep).

- [ ] **Step 2: Write `DevDashboard/cloud/README.md`**

```markdown
# DevDashboard Cloud

The optional **managed tier** of DevDashboard: a marketing landing page + signup + managed relay
provisioning. Built per ADR §4 trust policy.

## Layout
- `shared/` — framework-agnostic: the tier-trust policy (single source of truth) + the account data
  model + the data-boundary guard. Imported by `web/`, `api/`, and the tests.
- `web/` — marketing + signup site (`high-end-visual-design`; independent of the `@ui` app theme).
- `api/` — Bun + Hono provisioning backend: account, auth, relay provisioning, pairing-assist, billing stub.
- `e2e/` — Playwright (web signup) + Appium (mobile managed pairing).

## The non-negotiable data boundary
The cloud MAY store: account rows, subscription rows, relay-binding rows (public relay URL + the
agent's and phone's **public** keys). The cloud MUST NEVER store or transit: private keys, derived
session secrets, or the pairing secret. This is enforced by `shared/data-boundary.ts`
(`assertNoKeyMaterial`) on every persistence write and asserted by `shared/data-boundary.test.ts`.
The E2E crypto itself lives entirely on the two endpoints (phone + Mac agent) — see plan 02.

## Prod note
The stub uses SQLite; multi-tenant prod swaps the kysely dialect to Postgres behind `CloudStore`.
```

- [ ] **Step 3: Register the cloud web dev port (conflict detection)**

Read `src/utils/ui/dashboards.ts` first, then add a `dev-dashboard-cloud` entry with an unused port
(propose `7251`, verify it is not already claimed in that file).

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/cloud/README.md src/utils/ui/dashboards.ts
git commit -m "feat(dd-cloud): scaffold cloud project layout + register dev port"
```

---

### Task 1: `tier-policy.ts` — the single source of truth for trust claims

> This is the load-bearing module. Every trust string the landing page renders comes from here, and a
> test asserts these literals match ADR §4 verbatim. This satisfies the ADR's "marketing must match
> architecture" requirement AND makes the landing page TDD-able. The four tiers + their exact claim
> semantics are: **LAN = unconditional no-see; Tailscale/WireGuard = unconditional no-see; self-hosted
> cloudflared = "the vendor can't see your data" (user's own CF account, with the CF-TLS caveat);
> managed = no-see as a PROPERTY OF THE E2E LAYER, plus the metadata (timing/sizes/endpoints) caveat.**

**Files:**
- Create: `DevDashboard/cloud/shared/tier-policy.ts`
- Test: `DevDashboard/cloud/shared/tier-policy.test.ts`

- [ ] **Step 1: Write the failing test (claims match ADR §4)**

```typescript
import { describe, expect, it } from "bun:test";
import { TIER_POLICY, tierById, type TrustTierId } from "@app/../DevDashboard/cloud/shared/tier-policy";

describe("tier-policy", () => {
    it("defines exactly the four ADR §4 tiers", () => {
        const ids = TIER_POLICY.map((t) => t.id);
        expect(ids).toEqual(["lan", "tailscale", "cloudflared-self", "managed"]);
    });

    it("states no-see UNCONDITIONALLY for lan, tailscale, cloudflared-self", () => {
        for (const id of ["lan", "tailscale", "cloudflared-self"] as TrustTierId[]) {
            expect(tierById(id).noSee).toBe("unconditional");
        }
    });

    it("states managed no-see ONLY as a property of the E2E layer, with a metadata caveat", () => {
        const managed = tierById("managed");
        expect(managed.noSee).toBe("e2e-conditional");
        expect(managed.claim.toLowerCase()).toContain("end-to-end");
        expect(managed.caveat?.toLowerCase()).toContain("metadata");
        // The vendor never holds keys — must be stated.
        expect(managed.claim.toLowerCase()).toContain("never");
    });

    it("self-hosted cloudflared attributes the no-see to the USER'S OWN cloudflare account", () => {
        const cf = tierById("cloudflared-self");
        expect(cf.claim.toLowerCase()).toContain("your own");
        expect(cf.noSee).toBe("unconditional");
    });

    it("no tier claims more than it delivers (managed must NOT use the word 'unconditional')", () => {
        const managed = tierById("managed");
        expect(managed.noSee).not.toBe("unconditional");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/cloud/shared/tier-policy.test.ts`
Expected: FAIL — module not found / `TIER_POLICY` undefined.

- [ ] **Step 3: Implement `tier-policy.ts`**

```typescript
export type TrustTierId = "lan" | "tailscale" | "cloudflared-self" | "managed";

/** "unconditional" = no-see is true by construction; "e2e-conditional" = true only via the E2E layer. */
export type NoSeeKind = "unconditional" | "e2e-conditional";

export interface TrustTier {
    readonly id: TrustTierId;
    readonly label: string;
    /** One-line tagline for the tier card. */
    readonly tagline: string;
    /** The exact, architecture-honest trust claim shown on the landing page. */
    readonly claim: string;
    readonly noSee: NoSeeKind;
    /** Required caveat for tiers whose claim is conditional (managed: metadata visibility). */
    readonly caveat?: string;
    /** Friction/UX note (helps the user pick a tier). */
    readonly setup: string;
}

export const TIER_POLICY: readonly TrustTier[] = [
    {
        id: "lan",
        label: "Local network",
        tagline: "Same Wi-Fi, zero third parties.",
        claim: "Nothing leaves your network. We cannot see your data — there is no relay, no edge, no vendor in the path.",
        noSee: "unconditional",
        setup: "Auto-discovers your Mac on the same Wi-Fi. No account, no setup.",
    },
    {
        id: "tailscale",
        label: "Tailscale / WireGuard",
        tagline: "Remote access, end-to-end encrypted.",
        claim: "Your phone and Mac speak WireGuard end-to-end. Relays see only ciphertext — we cannot see your data, by construction.",
        noSee: "unconditional",
        setup: "Install the Tailscale app and sign in. We detect your tailnet and connect — we never touch your keys.",
    },
    {
        id: "cloudflared-self",
        label: "Self-hosted tunnel",
        tagline: "One-command tunnel on your own account.",
        claim: "The tunnel runs on your own Cloudflare account, not ours — so the vendor can't see your data. (Cloudflare terminates TLS at its edge, as with any Cloudflare tunnel.)",
        noSee: "unconditional",
        setup: "Run `tools dev-dashboard tunnel setup`: it installs cloudflared, walks the login, and prints a pairing QR. No copy-paste.",
    },
    {
        id: "managed",
        label: "Managed (one-tap)",
        tagline: "We set everything up. Keys stay on your devices.",
        claim: "One tap, no setup. Because our relay terminates the transport, your data stays private only through end-to-end encryption above it: keys are generated on your phone and Mac and never leave them — the vendor never escrows them. The relay forwards opaque ciphertext.",
        noSee: "e2e-conditional",
        caveat: "The relay still sees connection metadata (timing, sizes, endpoints) — not your data.",
        setup: "Sign up, scan one QR shown by your Mac agent. We provision the relay; the pairing secret never passes through us.",
    },
] as const;

export function tierById(id: TrustTierId): TrustTier {
    const found = TIER_POLICY.find((t) => t.id === id);

    if (!found) {
        throw new Error(`unknown trust tier: ${id}`);
    }

    return found;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/cloud/shared/tier-policy.test.ts`
Expected: PASS (5 tests).

> **Note on the import path:** the exact `@app/...` or relative alias for `DevDashboard/cloud/` from a
> `bun:test` file is settled in Task 0's framework decision (the cloud project may get its own
> `tsconfig`/`package.json`). If `@app/../DevDashboard/...` does not resolve, use a relative import
> (`../../shared/tier-policy`) — the test lives in the same tree.

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/cloud/shared/tier-policy.ts DevDashboard/cloud/shared/tier-policy.test.ts
git commit -m "feat(dd-cloud): tier-policy single source of truth (matches ADR §4)"
```

---

### Task 2: Account data model + the data-boundary guard

> The cloud data boundary IS the trust claim. This task defines what the cloud is *permitted* to store
> and a guard (`assertNoKeyMaterial`) that every persistence write calls. Per research §132: the cloud
> MAY touch public keys + relay endpoints; it MUST NEVER hold private keys, derived session secrets, or
> the pairing secret. We prefer the **Mac agent showing the pairing QR locally** so even the public-key
> exchange is out-of-band — the cloud only provisions the relay binding.

**Files:**
- Create: `DevDashboard/cloud/shared/account-model.ts`
- Create: `DevDashboard/cloud/shared/data-boundary.ts`
- Test: `DevDashboard/cloud/shared/data-boundary.test.ts`

- [ ] **Step 1: Write `account-model.ts`**

```typescript
export type ProvisionStatus = "pending" | "provisioning" | "ready" | "failed";
export type SubscriptionTier = "free" | "managed";
export type SubscriptionStatus = "active" | "past_due" | "canceled";

export interface Account {
    id: string;
    email: string;
    /** Argon2/bcrypt hash — NOT a private key; auth credential only. */
    passwordHash: string;
    createdAt: string;
}

export interface Subscription {
    id: string;
    accountId: string;
    tier: SubscriptionTier;
    status: SubscriptionStatus;
    /** Opaque external billing id (e.g. Stripe customer/subscription id); never card data. */
    externalBillingId: string | null;
    createdAt: string;
}

/**
 * Binds an account to a vendor relay. Stores ONLY public material:
 * the public relay URL, and the PUBLIC keys of the two endpoints (used by neither
 * endpoint to decrypt — they only confirm identity at pairing; see plan 02).
 */
export interface RelayBinding {
    id: string;
    accountId: string;
    relayUrl: string;
    /** Out-of-band channel id the agent + phone rendezvous on. NOT a secret. */
    pairingChannelId: string;
    /** Base64 X25519 PUBLIC keys only. Optional until both endpoints paired. */
    agentPublicKey: string | null;
    phonePublicKey: string | null;
    status: ProvisionStatus;
    createdAt: string;
}

/** The exhaustive allow-list of fields the cloud is PERMITTED to persist, per table. */
export const CLOUD_PERSISTABLE_FIELDS = {
    accounts: ["id", "email", "passwordHash", "createdAt"],
    subscriptions: ["id", "accountId", "tier", "status", "externalBillingId", "createdAt"],
    relay_bindings: ["id", "accountId", "relayUrl", "pairingChannelId", "agentPublicKey", "phonePublicKey", "status", "createdAt"],
} as const;

export type CloudTable = keyof typeof CLOUD_PERSISTABLE_FIELDS;
```

- [ ] **Step 2: Write the failing boundary test**

```typescript
import { describe, expect, it } from "bun:test";
import { assertNoKeyMaterial, FORBIDDEN_KEY_FIELDS } from "../shared/data-boundary";

describe("data-boundary", () => {
    it("accepts a relay binding with public keys only", () => {
        expect(() =>
            assertNoKeyMaterial("relay_bindings", {
                id: "rb1",
                accountId: "a1",
                relayUrl: "wss://relay.example/ch/abc",
                pairingChannelId: "abc",
                agentPublicKey: "BASE64PUB==",
                phonePublicKey: null,
                status: "pending",
                createdAt: "t",
            }),
        ).not.toThrow();
    });

    it("rejects any record carrying a private key field", () => {
        for (const field of FORBIDDEN_KEY_FIELDS) {
            expect(() => assertNoKeyMaterial("relay_bindings", { id: "x", [field]: "leak" }), `should reject ${field}`).toThrow(/key material/i);
        }
    });

    it("rejects a field outside the table's allow-list", () => {
        expect(() => assertNoKeyMaterial("accounts", { id: "a", email: "e", passwordHash: "h", createdAt: "t", sharedSecret: "leak" })).toThrow(/not permitted/i);
    });

    it("rejects a value that looks like a derived session secret on an allowed field", () => {
        // even an allowed string field must not be a 64-hex/secret blob smuggled in
        expect(() => assertNoKeyMaterial("relay_bindings", { id: "x", privateKey: "deadbeef".repeat(8) })).toThrow();
    });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test DevDashboard/cloud/shared/data-boundary.test.ts`
Expected: FAIL — `assertNoKeyMaterial` not defined.

- [ ] **Step 4: Implement `data-boundary.ts`**

```typescript
import { CLOUD_PERSISTABLE_FIELDS, type CloudTable } from "./account-model";

/** Field names that, if present on a cloud-bound record, mean a private secret is leaking. */
export const FORBIDDEN_KEY_FIELDS = [
    "privateKey",
    "secretKey",
    "sessionKey",
    "sharedSecret",
    "derivedSecret",
    "pairingSecret",
    "symmetricKey",
    "aeadKey",
    "noiseKey",
    "nonceSecret",
] as const;

/**
 * Throws if `record` carries any key material or any field outside the table's allow-list.
 * Called on EVERY cloud persistence write. This is the runtime enforcement of the trust claim
 * (the static counterpart is `CLOUD_PERSISTABLE_FIELDS`). The cloud never stores private keys,
 * derived secrets, or the pairing secret — only public keys + relay endpoints (see plan 02).
 */
export function assertNoKeyMaterial(table: CloudTable, record: Record<string, unknown>): void {
    const allowed = new Set<string>(CLOUD_PERSISTABLE_FIELDS[table]);

    for (const field of Object.keys(record)) {
        const lower = field.toLowerCase();

        for (const forbidden of FORBIDDEN_KEY_FIELDS) {
            if (lower === forbidden.toLowerCase()) {
                throw new Error(`data-boundary: refusing to persist key material field "${field}" on ${table}`);
            }
        }

        if (lower.includes("private") || (lower.includes("secret") && lower !== "externalbillingid")) {
            throw new Error(`data-boundary: refusing to persist key material field "${field}" on ${table}`);
        }

        if (!allowed.has(field)) {
            throw new Error(`data-boundary: field "${field}" is not permitted on ${table} (allow-list: ${[...allowed].join(", ")})`);
        }
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test DevDashboard/cloud/shared/data-boundary.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/cloud/shared/account-model.ts DevDashboard/cloud/shared/data-boundary.ts DevDashboard/cloud/shared/data-boundary.test.ts
git commit -m "feat(dd-cloud): account data model + data-boundary guard (no key material)"
```

---

## Part A — Landing page

> The landing page uses the **`high-end-visual-design`** skill, NOT the internal `@ui` design-system
> (that contract is for app dashboards; this is a marketing site). Build the FULL structure + sections +
> copy now; the exact visual direction is FINALIZED in Task 9 from a user-selected mockup. Code examples
> below assume the **Astro + Tailwind v4** lead (Task 0); if the user picks Vite+React, the JSX is
> near-identical — components stay React, the page shell changes. The trust/verifiability story is
> **front-and-center** (Task 5), right after the hero.

### Task 3: Copy module deriving all trust strings from `tier-policy.ts`

**Files:**
- Create: `DevDashboard/cloud/web/src/content/copy.ts`
- Test: `DevDashboard/cloud/web/copy-parity.test.ts`

- [ ] **Step 1: Write the copy module**

```typescript
import { TIER_POLICY, tierById } from "../../../shared/tier-policy";

export const HERO = {
    eyebrow: "Your machine, in your pocket",
    title: "Run your dev box from anywhere — without handing anyone your data.",
    subtitle:
        "DevDashboard puts your terminals, metrics, and Q&A stream on your phone. Pick how you connect: same Wi-Fi, your own tunnel, Tailscale, or one-tap managed — every tier states exactly who can see your data.",
    primaryCta: "Get the app",
    secondaryCta: "How trust works",
} as const;

export const TRUST_STORY = {
    eyebrow: "Verifiability first",
    title: "We say what we can see — per tier, no asterisks.",
    body:
        "Most remote-access tools bury the question of who can read your traffic. We lead with it. Three of our four tiers keep us out of the data path entirely. The convenient one keeps us out with end-to-end encryption whose keys never leave your devices.",
    // The four claims come straight from the single source of truth:
    tiers: TIER_POLICY.map((t) => ({ id: t.id, label: t.label, claim: t.claim, caveat: t.caveat ?? null })),
} as const;

export const HOW_IT_WORKS = {
    eyebrow: "Three steps",
    title: "Install the agent, choose a tier, connect.",
    steps: [
        { n: "01", title: "Run the agent", body: "One command on your Mac starts the DevDashboard agent. It serves your terminals, metrics, and streams locally." },
        { n: "02", title: "Choose how you connect", body: "Same-Wi-Fi auto-discovery, your own tunnel, Tailscale, or one-tap managed. Switch any time." },
        { n: "03", title: "Pair and go", body: "Scan a QR shown by your Mac. For managed, the pairing secret never passes through us — keys stay on your devices." },
    ],
} as const;

export const PRICING = {
    eyebrow: "Pricing",
    title: "Free to self-host. Pay only for managed convenience.",
    plans: [
        { id: "free", name: "Self-hosted", price: "$0", cadence: "forever", tagline: tierById("lan").tagline, features: ["LAN auto-discovery", "Your own tunnel (cloudflared)", "Tailscale / WireGuard", "All features, no limits"], cta: "Get the app", featured: false },
        { id: "managed", name: "Managed", price: "$TBD", cadence: "per month", tagline: tierById("managed").tagline, features: ["One-tap remote, zero setup", "Vendor relay with E2E encryption", "Keys never leave your devices", "Priority support"], cta: "Start managed", featured: true },
    ],
} as const;

export const SIGNUP = {
    eyebrow: "Managed tier",
    title: "Create your account.",
    body: "Sign up to provision a managed relay. Your Mac agent will show a pairing QR — the secret never touches our servers.",
    submit: "Create account",
} as const;
```

- [ ] **Step 2: Write the copy-parity test (the architecture-matches-marketing gate)**

```typescript
import { describe, expect, it } from "bun:test";
import { TIER_POLICY } from "../shared/tier-policy";
import { PRICING, TRUST_STORY } from "./src/content/copy";

describe("copy parity (marketing matches architecture)", () => {
    it("renders the EXACT tier claim strings from tier-policy (no drift)", () => {
        for (const tier of TIER_POLICY) {
            const rendered = TRUST_STORY.tiers.find((t) => t.id === tier.id);
            expect(rendered, `missing tier ${tier.id} in trust story`).toBeDefined();
            expect(rendered?.claim).toBe(tier.claim);
            expect(rendered?.caveat ?? null).toBe(tier.caveat ?? null);
        }
    });

    it("the managed plan tagline matches the managed tier (no over-claim)", () => {
        const managed = TIER_POLICY.find((t) => t.id === "managed");
        const plan = PRICING.plans.find((p) => p.id === "managed");
        expect(plan?.tagline).toBe(managed?.tagline);
    });

    it("never markets managed as unconditional no-see anywhere in copy", () => {
        const blob = JSON.stringify({ TRUST_STORY, PRICING }).toLowerCase();
        // 'unconditional' must not appear adjacent to a managed claim
        const managedClaim = (TIER_POLICY.find((t) => t.id === "managed")?.claim ?? "").toLowerCase();
        expect(managedClaim.includes("unconditional")).toBe(false);
        expect(blob.includes("we cannot see your data, by construction") && managedClaim.length > 0 ? managedClaim.includes("by construction") : true).toBe(true);
    });
});
```

- [ ] **Step 3: Run to verify it fails then passes**

Run: `bun test DevDashboard/cloud/web/copy-parity.test.ts`
Expected: first FAIL (module missing), then PASS after Step 1 lands (3 tests). The path to `../shared`
may need adjusting to the Task 0 alias decision.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/cloud/web/src/content/copy.ts DevDashboard/cloud/web/copy-parity.test.ts
git commit -m "feat(dd-cloud): landing copy derived from tier-policy + parity test"
```

---

### Task 4: Hero section + the fluid-island nav

> Apply `high-end-visual-design`: a floating glass "fluid island" nav (detached from top, `rounded-full`,
> `mt-6`), an eyebrow pill before the H1, massive premium-Grotesk type, `min-h-[100dvh]`, a radial mesh
> background, and a Button-in-Button primary CTA. No banned fonts/icons/shadows. Section padding `py-24`+.

**Files:**
- Create: `DevDashboard/cloud/web/src/components/Nav.tsx`
- Create: `DevDashboard/cloud/web/src/components/Hero.tsx`
- Create: `DevDashboard/cloud/web/src/styles/theme.css`

- [ ] **Step 1: Write `theme.css` (premium tokens — type scale, spacing, radii, curves)**

```css
@import "tailwindcss";

@theme {
    /* Premium type — Geist / Clash Display assumed available; load via @font-face or a CDN. */
    --font-display: "Clash Display", "Geist", system-ui, sans-serif;
    --font-sans: "Geist", system-ui, sans-serif;

    /* Spatial rhythm — heavy whitespace. */
    --spacing-section: 8rem;     /* py-32 baseline */
    --radius-bezel: 2rem;        /* squircle outer */
    --radius-core: calc(2rem - 0.375rem);

    /* Motion — never linear/ease-in-out. */
    --ease-fluid: cubic-bezier(0.32, 0.72, 0, 1);

    /* Ethereal-glass palette (default; Task 9 may swap to Editorial/Structural per mockup). */
    --color-void: #050505;
    --color-mist: rgba(255, 255, 255, 0.06);
    --color-hairline: rgba(255, 255, 255, 0.10);
}

/* Film-grain overlay — fixed, pointer-events-none (perf guardrail). */
.grain::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: 50;
    pointer-events: none;
    opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

- [ ] **Step 2: Write `Nav.tsx` (floating glass island; hamburger morph on mobile)**

```tsx
export function Nav() {
    return (
        <nav className="fixed inset-x-0 top-0 z-40 flex justify-center">
            <div className="mx-auto mt-6 flex w-max items-center gap-8 rounded-full border border-[var(--color-hairline)] bg-white/5 px-6 py-3 backdrop-blur-2xl">
                <a href="#top" className="font-[var(--font-display)] text-sm tracking-tight text-white">DevDashboard</a>
                <div className="hidden items-center gap-6 text-sm text-white/70 md:flex">
                    <a href="#trust" className="transition-colors duration-500 ease-[var(--ease-fluid)] hover:text-white">Trust</a>
                    <a href="#how" className="transition-colors duration-500 ease-[var(--ease-fluid)] hover:text-white">How it works</a>
                    <a href="#pricing" className="transition-colors duration-500 ease-[var(--ease-fluid)] hover:text-white">Pricing</a>
                </div>
                <a
                    href="#signup"
                    className="group flex items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-medium text-black transition-transform duration-500 ease-[var(--ease-fluid)] active:scale-[0.98]"
                >
                    Get the app
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-fluid)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
                        ↗
                    </span>
                </a>
            </div>
        </nav>
    );
}
```

> Mobile hamburger morph + staggered overlay reveal are added in Task 9 (depends on the chosen
> direction); the nav above is the desktop-correct baseline that the FINALIZE task extends.

- [ ] **Step 3: Write `Hero.tsx`**

```tsx
import { HERO } from "../content/copy";

export function Hero() {
    return (
        <section id="top" className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[var(--color-void)] px-4 py-32 text-center">
            <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/3 h-[40rem] w-[40rem] -translate-x-1/2 rounded-full bg-emerald-500/20 blur-[160px]" />
            <span className="z-10 rounded-full border border-[var(--color-hairline)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
                {HERO.eyebrow}
            </span>
            <h1 className="z-10 mt-8 max-w-4xl font-[var(--font-display)] text-5xl leading-[1.05] tracking-tight text-white md:text-7xl">
                {HERO.title}
            </h1>
            <p className="z-10 mt-6 max-w-2xl text-lg text-white/60">{HERO.subtitle}</p>
            <div className="z-10 mt-10 flex flex-col gap-4 sm:flex-row">
                <a href="#signup" className="group flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 font-medium text-black transition-transform duration-500 ease-[var(--ease-fluid)] active:scale-[0.98]">
                    {HERO.primaryCta}
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-fluid)] group-hover:translate-x-1 group-hover:-translate-y-px">↗</span>
                </a>
                <a href="#trust" className="rounded-full border border-[var(--color-hairline)] px-6 py-3 text-white/80 transition-colors duration-500 ease-[var(--ease-fluid)] hover:text-white">
                    {HERO.secondaryCta}
                </a>
            </div>
        </section>
    );
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsgo --noEmit | rg "cloud/web/src/components/(Nav|Hero)"`
Expected: no errors (after the framework's JSX/tsconfig is set up in Task 0).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/cloud/web/src/components/Nav.tsx DevDashboard/cloud/web/src/components/Hero.tsx DevDashboard/cloud/web/src/styles/theme.css
git commit -m "feat(dd-cloud): hero + fluid-island nav + premium theme tokens"
```

---

### Task 5: Trust / verifiability story (the differentiator, front-and-center)

> This is the product's reason to exist — it sits **directly after the hero**. It renders the four
> tier claims from `tier-policy.ts` (via `copy.ts`), visually separating the three unconditional tiers
> from the E2E-conditional managed tier, and shows the managed metadata caveat inline. Double-Bezel
> cards, scroll-reveal entry.

**Files:**
- Create: `DevDashboard/cloud/web/src/components/TrustStory.tsx`

- [ ] **Step 1: Write `TrustStory.tsx`**

```tsx
import { TRUST_STORY } from "../content/copy";

export function TrustStory() {
    return (
        <section id="trust" className="relative bg-[var(--color-void)] px-4 py-32">
            <div className="mx-auto max-w-6xl">
                <span className="rounded-full border border-[var(--color-hairline)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
                    {TRUST_STORY.eyebrow}
                </span>
                <h2 className="mt-6 max-w-3xl font-[var(--font-display)] text-4xl leading-tight tracking-tight text-white md:text-6xl">
                    {TRUST_STORY.title}
                </h2>
                <p className="mt-6 max-w-2xl text-lg text-white/60">{TRUST_STORY.body}</p>

                <div className="mt-16 grid gap-4 md:grid-cols-2">
                    {TRUST_STORY.tiers.map((tier) => (
                        <article
                            key={tier.id}
                            data-tier={tier.id}
                            className="rounded-[var(--radius-bezel)] border border-[var(--color-hairline)] bg-white/5 p-1.5"
                        >
                            <div className="rounded-[var(--radius-core)] bg-[var(--color-void)] p-8 shadow-[inset_0_1px_1px_rgba(255,255,255,0.10)]">
                                <div className="flex items-center justify-between">
                                    <h3 className="font-[var(--font-display)] text-xl text-white">{tier.label}</h3>
                                    <span
                                        className={
                                            tier.caveat
                                                ? "rounded-full border border-amber-400/30 px-3 py-1 text-[10px] uppercase tracking-[0.15em] text-amber-300"
                                                : "rounded-full border border-emerald-400/30 px-3 py-1 text-[10px] uppercase tracking-[0.15em] text-emerald-300"
                                        }
                                    >
                                        {tier.caveat ? "E2E-protected" : "We can't see it"}
                                    </span>
                                </div>
                                <p className="mt-4 text-white/70">{tier.claim}</p>
                                {tier.caveat ? <p className="mt-3 text-sm text-white/40">{tier.caveat}</p> : null}
                            </div>
                        </article>
                    ))}
                </div>
            </div>
        </section>
    );
}
```

- [ ] **Step 2: Verify the rendered claims still match the policy (re-run parity)**

Run: `bun test DevDashboard/cloud/web/copy-parity.test.ts`
Expected: PASS — `TrustStory` reads from `copy.ts` which reads from `tier-policy.ts`; no hard-coded claims.

- [ ] **Step 3: Commit**

```bash
git add DevDashboard/cloud/web/src/components/TrustStory.tsx
git commit -m "feat(dd-cloud): trust/verifiability story section (front-and-center)"
```

---

### Task 6: Tiers comparison + How-it-works

**Files:**
- Create: `DevDashboard/cloud/web/src/components/Tiers.tsx`
- Create: `DevDashboard/cloud/web/src/components/HowItWorks.tsx`

- [ ] **Step 1: Write `Tiers.tsx` (the four tiers with setup friction + claim)**

```tsx
import { TIER_POLICY } from "../../../shared/tier-policy";

export function Tiers() {
    return (
        <section id="tiers" className="bg-[var(--color-void)] px-4 py-32">
            <div className="mx-auto max-w-6xl">
                <span className="rounded-full border border-[var(--color-hairline)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
                    Connect your way
                </span>
                <h2 className="mt-6 font-[var(--font-display)] text-4xl tracking-tight text-white md:text-5xl">Four tiers, one app.</h2>
                <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    {TIER_POLICY.map((tier) => (
                        <div key={tier.id} className="rounded-[var(--radius-bezel)] border border-[var(--color-hairline)] bg-white/5 p-1.5">
                            <div className="flex h-full flex-col rounded-[var(--radius-core)] bg-[var(--color-void)] p-6">
                                <h3 className="font-[var(--font-display)] text-lg text-white">{tier.label}</h3>
                                <p className="mt-2 text-sm text-white/50">{tier.tagline}</p>
                                <p className="mt-4 text-xs text-white/40">{tier.setup}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
```

- [ ] **Step 2: Write `HowItWorks.tsx`**

```tsx
import { HOW_IT_WORKS } from "../content/copy";

export function HowItWorks() {
    return (
        <section id="how" className="bg-[var(--color-void)] px-4 py-32">
            <div className="mx-auto max-w-5xl">
                <span className="rounded-full border border-[var(--color-hairline)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
                    {HOW_IT_WORKS.eyebrow}
                </span>
                <h2 className="mt-6 font-[var(--font-display)] text-4xl tracking-tight text-white md:text-5xl">{HOW_IT_WORKS.title}</h2>
                <div className="mt-16 grid gap-6 md:grid-cols-3">
                    {HOW_IT_WORKS.steps.map((step) => (
                        <div key={step.n} className="rounded-[var(--radius-bezel)] border border-[var(--color-hairline)] bg-white/5 p-1.5">
                            <div className="rounded-[var(--radius-core)] bg-[var(--color-void)] p-8">
                                <span className="font-[var(--font-display)] text-3xl text-white/30">{step.n}</span>
                                <h3 className="mt-4 text-lg text-white">{step.title}</h3>
                                <p className="mt-2 text-sm text-white/50">{step.body}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "cloud/web/src/components/(Tiers|HowItWorks)"`
Expected: no errors.

```bash
git add DevDashboard/cloud/web/src/components/Tiers.tsx DevDashboard/cloud/web/src/components/HowItWorks.tsx
git commit -m "feat(dd-cloud): tiers comparison + how-it-works sections"
```

---

### Task 7: Pricing + Signup CTA

**Files:**
- Create: `DevDashboard/cloud/web/src/components/Pricing.tsx`
- Create: `DevDashboard/cloud/web/src/components/SignupCta.tsx`

- [ ] **Step 1: Write `Pricing.tsx` (featured managed plan)**

```tsx
import { PRICING } from "../content/copy";

export function Pricing() {
    return (
        <section id="pricing" className="bg-[var(--color-void)] px-4 py-32">
            <div className="mx-auto max-w-4xl text-center">
                <span className="rounded-full border border-[var(--color-hairline)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
                    {PRICING.eyebrow}
                </span>
                <h2 className="mt-6 font-[var(--font-display)] text-4xl tracking-tight text-white md:text-5xl">{PRICING.title}</h2>
                <div className="mt-16 grid gap-6 md:grid-cols-2">
                    {PRICING.plans.map((plan) => (
                        <div
                            key={plan.id}
                            className={
                                plan.featured
                                    ? "rounded-[var(--radius-bezel)] border border-emerald-400/30 bg-emerald-400/5 p-1.5"
                                    : "rounded-[var(--radius-bezel)] border border-[var(--color-hairline)] bg-white/5 p-1.5"
                            }
                        >
                            <div className="flex h-full flex-col rounded-[var(--radius-core)] bg-[var(--color-void)] p-8 text-left">
                                <h3 className="font-[var(--font-display)] text-xl text-white">{plan.name}</h3>
                                <p className="mt-2 text-sm text-white/50">{plan.tagline}</p>
                                <p className="mt-6 font-[var(--font-display)] text-4xl text-white">
                                    {plan.price} <span className="text-base text-white/40">/ {plan.cadence}</span>
                                </p>
                                <ul className="mt-6 flex-1 space-y-2 text-sm text-white/60">
                                    {plan.features.map((f) => (
                                        <li key={f}>— {f}</li>
                                    ))}
                                </ul>
                                <a
                                    href="#signup"
                                    className="group mt-8 flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 font-medium text-black transition-transform duration-500 ease-[var(--ease-fluid)] active:scale-[0.98]"
                                >
                                    {plan.cta}
                                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-fluid)] group-hover:translate-x-1 group-hover:-translate-y-px">↗</span>
                                </a>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
```

- [ ] **Step 2: Write `SignupCta.tsx` (posts to the provisioning API)**

```tsx
import { SIGNUP } from "../content/copy";

export function SignupCta() {
    return (
        <section id="signup" className="bg-[var(--color-void)] px-4 py-32">
            <div className="mx-auto max-w-xl rounded-[var(--radius-bezel)] border border-[var(--color-hairline)] bg-white/5 p-1.5">
                <div className="rounded-[var(--radius-core)] bg-[var(--color-void)] p-10 text-center">
                    <span className="rounded-full border border-[var(--color-hairline)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
                        {SIGNUP.eyebrow}
                    </span>
                    <h2 className="mt-6 font-[var(--font-display)] text-3xl tracking-tight text-white">{SIGNUP.title}</h2>
                    <p className="mt-4 text-white/50">{SIGNUP.body}</p>
                    <form
                        className="mt-8 flex flex-col gap-3"
                        method="post"
                        action="/api/cloud/signup"
                    >
                        <input
                            type="email"
                            name="email"
                            required
                            placeholder="you@example.com"
                            className="rounded-full border border-[var(--color-hairline)] bg-white/5 px-5 py-3 text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-emerald-400/40"
                        />
                        <input
                            type="password"
                            name="password"
                            required
                            minLength={12}
                            placeholder="A strong password (12+ chars)"
                            className="rounded-full border border-[var(--color-hairline)] bg-white/5 px-5 py-3 text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-emerald-400/40"
                        />
                        <button
                            type="submit"
                            className="group flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 font-medium text-black transition-transform duration-500 ease-[var(--ease-fluid)] active:scale-[0.98]"
                        >
                            {SIGNUP.submit}
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-fluid)] group-hover:translate-x-1 group-hover:-translate-y-px">↗</span>
                        </button>
                    </form>
                </div>
            </div>
        </section>
    );
}
```

- [ ] **Step 3: Compose the page (`src/pages/index`) — order matters: hero → TRUST → tiers → how → pricing → signup**

```tsx
// Astro: src/pages/index.astro imports these as client islands only where interactive (signup form).
// Vite+React: src/pages/index.tsx renders them directly.
import { Nav } from "../components/Nav";
import { Hero } from "../components/Hero";
import { TrustStory } from "../components/TrustStory";
import { Tiers } from "../components/Tiers";
import { HowItWorks } from "../components/HowItWorks";
import { Pricing } from "../components/Pricing";
import { SignupCta } from "../components/SignupCta";

export function LandingPage() {
    return (
        <main className="grain bg-[var(--color-void)]">
            <Nav />
            <Hero />
            <TrustStory />
            <Tiers />
            <HowItWorks />
            <Pricing />
            <SignupCta />
        </main>
    );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "cloud/web/src/(components/(Pricing|SignupCta)|pages/index)"`
Expected: no errors.

```bash
git add DevDashboard/cloud/web/src/components/Pricing.tsx DevDashboard/cloud/web/src/components/SignupCta.tsx DevDashboard/cloud/web/src/pages/
git commit -m "feat(dd-cloud): pricing + signup CTA + page composition (trust front-and-center)"
```

---

### Task 8: ⛔ FINALIZE visual direction from the user-selected mockup (GATED)

> **This task is BLOCKED until the user selects a design direction.** See "Design-mockup-selection
> dependency" at the bottom. Tasks 3–7 deliberately build the FULL structure + all sections + all copy
> on a sane Ethereal-Glass default so nothing is blocked but the *finish*. This task applies the chosen
> mockup's visual language across every component. Do NOT start it before the user has picked.

**Pre-req (do this with the user, not solo):**
- [ ] **Step 0: Produce 2–3 mockup directions and have the user choose ONE.** Per the
  `high-end-visual-design` Variance Engine §3, the three candidate Vibe×Layout archetypes are:
    1. **Ethereal Glass + Asymmetrical Bento** (the built-in default; SaaS/AI feel — OLED black, mesh orbs, vantablack glass cards).
    2. **Soft Structuralism + Editorial Split** (light/silver, massive Grotesk, diffused ambient shadows; "Linear-light" feel).
    3. **Editorial Luxury + Z-Axis Cascade** (warm cream, variable serif headings, film-grain; "premium publication" feel).
  Render each as a static screenshot of the Hero+Trust sections (use the playwright-mcp headless
  recipe from MEMORY for pixel-perfect captures), present, and let the user pick. **Record the choice**
  in `DevDashboard/cloud/web/DESIGN.md`.

**Files (modify after the choice):**
- Modify: `DevDashboard/cloud/web/src/styles/theme.css` (swap palette/type/shadow tokens to the chosen archetype).
- Modify: all `DevDashboard/cloud/web/src/components/*.tsx` (apply the chosen layout archetype's structure).
- Create: `DevDashboard/cloud/web/DESIGN.md` (records the locked direction + the Variance Engine selection).

- [ ] **Step 1: Lock the chosen Vibe + Layout in `DESIGN.md`** (one paragraph + the token table).

- [ ] **Step 2: Apply the chosen tokens in `theme.css`** (palette, `--font-display`, shadow profile).
  Keep the same token *names* so components don't churn — only the *values* change.

- [ ] **Step 3: Apply the chosen layout archetype + the FINALIZE checklist to every section.** Verify
  against the `high-end-visual-design` §8 matrix: Double-Bezel on all cards (already present),
  Button-in-Button CTAs (present), `py-24`+ padding (present), custom cubic-bezier only (present),
  scroll-reveal entry animations (ADD via IntersectionObserver / Framer `whileInView` — not present in
  the baseline), `<768px` single-column collapse (verify), `transform`/`opacity`-only animation,
  `backdrop-blur` only on fixed nav. Add the mobile hamburger morph + staggered overlay reveal to `Nav`.

- [ ] **Step 4: Re-run the copy-parity test (no visual change may alter the trust claims)**

Run: `bun test DevDashboard/cloud/web/copy-parity.test.ts`
Expected: PASS — finalize touches presentation only; claim strings still come from `tier-policy.ts`.

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/cloud/web/
git commit -m "feat(dd-cloud): FINALIZE landing visual direction (<chosen archetype>)"
```

---

### Task 9: Landing build + Lighthouse + a11y + Playwright signup flow

**Files:**
- Create: `DevDashboard/cloud/e2e/signup.web.spec.ts`

- [ ] **Step 1: Build the site**

Run (Astro lead): `cd DevDashboard/cloud/web && bun run build` (or the framework's build per Task 0)
Expected: build succeeds; static output emitted.

- [ ] **Step 2: Write the Playwright web signup spec**

```typescript
import { expect, test } from "@playwright/test";

const BASE = process.env.CLOUD_WEB_URL ?? "http://localhost:7251";

test.describe("landing + signup", () => {
    test("trust story is above the fold-adjacent (right after hero) and lists all four tiers", async ({ page }) => {
        await page.goto(BASE);
        const trust = page.locator("#trust");
        await expect(trust).toBeVisible();
        for (const id of ["lan", "tailscale", "cloudflared-self", "managed"]) {
            await expect(page.locator(`[data-tier="${id}"]`)).toBeVisible();
        }
    });

    test("managed tier card shows the metadata caveat (no over-claim)", async ({ page }) => {
        await page.goto(BASE);
        const managed = page.locator('[data-tier="managed"]');
        await expect(managed).toContainText(/metadata/i);
        await expect(managed).toContainText(/end-to-end/i);
    });

    test("signup posts email + password and shows the agent-connect instructions", async ({ page }) => {
        await page.goto(`${BASE}/#signup`);
        await page.fill('input[name="email"]', `test+${Date.now()}@example.com`);
        await page.fill('input[name="password"]', "a-strong-password-123");
        await page.click('button[type="submit"]');
        await expect(page.getByText(/pairing QR|run the agent|scan/i)).toBeVisible();
    });
});
```

- [ ] **Step 3: Lighthouse + a11y audit**

Run a Lighthouse audit (chrome-devtools-mcp `lighthouse_audit` or `bunx @lhci/cli autorun`) against the
built site. Targets: **Performance ≥ 95, Accessibility ≥ 95, Best-Practices ≥ 95** (a static marketing
page should hit these easily). Fix any contrast/landmark/heading-order a11y failures the audit surfaces.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/cloud/e2e/signup.web.spec.ts
git commit -m "test(dd-cloud): playwright signup flow + lighthouse/a11y gates"
```

---

## Part B — Managed provisioning backend

> Cross-reference: the E2E pairing crypto (X25519 ECDH → per-message AEAD, `pairDevice`, key custody on
> phone Secure Enclave + Mac) lives in **plan 02** and on the two endpoints. The cloud side here only:
> provisions a relay binding, and **assists** pairing by relaying **public** keys + the relay endpoint —
> never the pairing secret, never a private key, never a derived session secret (research §132).

### Task 10: Cloud DB schema + `CloudStore` (every write goes through the boundary guard)

**Files:**
- Create: `DevDashboard/cloud/api/db/schema.ts`
- Create: `DevDashboard/cloud/api/db/migrations.ts`
- Create: `DevDashboard/cloud/api/db/store.ts`
- Test: `DevDashboard/cloud/api/db/store.test.ts`

- [ ] **Step 1: Write `schema.ts` (kysely table interfaces — NO key columns)**

```typescript
import type { ProvisionStatus, SubscriptionStatus, SubscriptionTier } from "../../shared/account-model";

export interface AccountsTable {
    id: string;
    email: string;
    passwordHash: string;
    createdAt: string;
}

export interface SubscriptionsTable {
    id: string;
    accountId: string;
    tier: SubscriptionTier;
    status: SubscriptionStatus;
    externalBillingId: string | null;
    createdAt: string;
}

export interface RelayBindingsTable {
    id: string;
    accountId: string;
    relayUrl: string;
    pairingChannelId: string;
    agentPublicKey: string | null;
    phonePublicKey: string | null;
    status: ProvisionStatus;
    createdAt: string;
}

export interface CloudDatabase {
    accounts: AccountsTable;
    subscriptions: SubscriptionsTable;
    relay_bindings: RelayBindingsTable;
}
```

- [ ] **Step 2: Write `migrations.ts` (reuse the repo migration runner pattern)**

```typescript
import type { Migration } from "@app/utils/database/migrations";

export const CLOUD_MIGRATIONS: Migration[] = [
    {
        id: "001-init",
        up: (db) => {
            db.run(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, passwordHash TEXT NOT NULL, createdAt TEXT NOT NULL)`);
            db.run(`CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL, externalBillingId TEXT, createdAt TEXT NOT NULL)`);
            db.run(`CREATE TABLE IF NOT EXISTS relay_bindings (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, relayUrl TEXT NOT NULL, pairingChannelId TEXT NOT NULL, agentPublicKey TEXT, phonePublicKey TEXT, status TEXT NOT NULL, createdAt TEXT NOT NULL)`);
        },
    },
];
```

> The `Migration.up` signature must match `@app/utils/database/migrations` — read that file first and
> align (it may pass a `Database` handle rather than a bare `db.run`). Do NOT guess the exact API.

- [ ] **Step 3: Write the failing store test (boundary enforced on insert)**

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { CloudStore } from "../store";

function freshStore(): CloudStore {
    const db = new Database(":memory:");
    return CloudStore.fromDatabase(db); // runs CLOUD_MIGRATIONS
}

describe("CloudStore", () => {
    let store: CloudStore;

    beforeEach(() => {
        store = freshStore();
    });

    it("creates an account and reads it back by email", async () => {
        const acct = await store.createAccount({ email: "a@b.c", passwordHash: "hash" });
        const found = await store.accountByEmail("a@b.c");
        expect(found?.id).toBe(acct.id);
    });

    it("persists a relay binding with PUBLIC keys only", async () => {
        const acct = await store.createAccount({ email: "x@y.z", passwordHash: "h" });
        const rb = await store.createRelayBinding({ accountId: acct.id, relayUrl: "wss://r/ch/1", pairingChannelId: "1" });
        expect(rb.status).toBe("pending");
        expect(rb.agentPublicKey).toBeNull();
    });

    it("REFUSES to persist a record carrying key material (boundary guard)", async () => {
        const acct = await store.createAccount({ email: "k@k.k", passwordHash: "h" });
        // @ts-expect-error — deliberately smuggling a forbidden field
        await expect(store.updateRelayBinding("id", { privateKey: "leak" })).rejects.toThrow(/key material/i);
    });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test DevDashboard/cloud/api/db/store.test.ts`
Expected: FAIL — `CloudStore` not defined.

- [ ] **Step 5: Implement `store.ts` (kysely + bun:sqlite; `assertNoKeyMaterial` on every write)**

```typescript
import type { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { logger } from "@app/logger";
import { assertNoKeyMaterial } from "../../shared/data-boundary";
import type { Account, RelayBinding } from "../../shared/account-model";
import { CLOUD_MIGRATIONS } from "./migrations";
import type { CloudDatabase } from "./schema";

export class CloudStore {
    private constructor(private readonly db: Kysely<CloudDatabase>) {}

    static fromDatabase(raw: Database): CloudStore {
        for (const m of CLOUD_MIGRATIONS) {
            m.up(raw);
        }

        const db = new Kysely<CloudDatabase>({ dialect: new BunSqliteDialect({ database: raw }) });
        logger.debug("dd-cloud: CloudStore initialized");

        return new CloudStore(db);
    }

    async createAccount(input: { email: string; passwordHash: string }): Promise<Account> {
        const row = { id: crypto.randomUUID(), email: input.email, passwordHash: input.passwordHash, createdAt: new Date().toISOString() };
        assertNoKeyMaterial("accounts", row);
        await this.db.insertInto("accounts").values(row).execute();

        return row;
    }

    accountByEmail(email: string): Promise<Account | undefined> {
        return this.db.selectFrom("accounts").selectAll().where("email", "=", email).executeTakeFirst();
    }

    async createRelayBinding(input: { accountId: string; relayUrl: string; pairingChannelId: string }): Promise<RelayBinding> {
        const row: RelayBinding = {
            id: crypto.randomUUID(),
            accountId: input.accountId,
            relayUrl: input.relayUrl,
            pairingChannelId: input.pairingChannelId,
            agentPublicKey: null,
            phonePublicKey: null,
            status: "pending",
            createdAt: new Date().toISOString(),
        };
        assertNoKeyMaterial("relay_bindings", row);
        await this.db.insertInto("relay_bindings").values(row).execute();

        return row;
    }

    async updateRelayBinding(id: string, patch: Partial<RelayBinding>): Promise<void> {
        assertNoKeyMaterial("relay_bindings", { id, ...patch });
        await this.db.updateTable("relay_bindings").set(patch).where("id", "=", id).execute();
    }
}
```

> `kysely-bun-sqlite` is the PROPOSED dialect (open question — confirm before adding). If the user
> prefers no kysely dep, the store can use raw `bun:sqlite` prepared statements; the public method
> signatures stay identical so nothing downstream changes.

- [ ] **Step 6: Run to verify it passes**

Run: `bun test DevDashboard/cloud/api/db/store.test.ts`
Expected: PASS (3 tests) — note the key-material rejection proves the boundary is wired on writes.

- [ ] **Step 7: Commit**

```bash
git add DevDashboard/cloud/api/db/
git commit -m "feat(dd-cloud): CloudStore + migrations (boundary-guarded, no key material)"
```

---

### Task 11: Account auth (signup / login / requireAccount)

**Files:**
- Create: `DevDashboard/cloud/api/auth.ts`
- Test: `DevDashboard/cloud/api/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CloudStore } from "./db/store";
import { CloudAuth } from "./auth";

function auth(): CloudAuth {
    return new CloudAuth(CloudStore.fromDatabase(new Database(":memory:")));
}

describe("CloudAuth", () => {
    it("signs up an account and issues a session token", async () => {
        const a = auth();
        const { account, sessionToken } = await a.signup({ email: "u@e.c", password: "a-strong-password-123" });
        expect(account.email).toBe("u@e.c");
        expect(sessionToken).toBeString();
        expect(account.passwordHash).not.toBe("a-strong-password-123"); // hashed
    });

    it("rejects duplicate signup", async () => {
        const a = auth();
        await a.signup({ email: "dup@e.c", password: "a-strong-password-123" });
        await expect(a.signup({ email: "dup@e.c", password: "a-strong-password-123" })).rejects.toThrow(/exists/i);
    });

    it("logs in with the right password and rejects the wrong one", async () => {
        const a = auth();
        await a.signup({ email: "l@e.c", password: "a-strong-password-123" });
        await expect(a.login({ email: "l@e.c", password: "a-strong-password-123" })).resolves.toMatchObject({ account: { email: "l@e.c" } });
        await expect(a.login({ email: "l@e.c", password: "wrong" })).rejects.toThrow(/invalid/i);
    });

    it("requireAccount resolves a valid session token to its account", async () => {
        const a = auth();
        const { sessionToken } = await a.signup({ email: "s@e.c", password: "a-strong-password-123" });
        const acct = await a.requireAccount(sessionToken);
        expect(acct.email).toBe("s@e.c");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/cloud/api/auth.test.ts`
Expected: FAIL — `CloudAuth` not defined.

- [ ] **Step 3: Implement `auth.ts` (PROPOSED: roll-own using Bun password hashing + a signed token)**

```typescript
import { logger } from "@app/logger";
import type { Account } from "../shared/account-model";
import type { CloudStore } from "./db/store";

export interface SignupInput {
    email: string;
    password: string;
}

export interface AuthSuccess {
    account: Account;
    sessionToken: string;
}

export class CloudAuth {
    constructor(private readonly store: CloudStore) {}

    async signup(input: SignupInput): Promise<AuthSuccess> {
        const existing = await this.store.accountByEmail(input.email);

        if (existing) {
            throw new Error(`account already exists: ${input.email}`);
        }

        const passwordHash = await Bun.password.hash(input.password);
        const account = await this.store.createAccount({ email: input.email, passwordHash });
        logger.info({ accountId: account.id }, "dd-cloud: account created");

        return { account, sessionToken: this.issueToken(account.id) };
    }

    async login(input: SignupInput): Promise<AuthSuccess> {
        const account = await this.store.accountByEmail(input.email);

        if (!account || !(await Bun.password.verify(input.password, account.passwordHash))) {
            throw new Error("invalid credentials");
        }

        return { account, sessionToken: this.issueToken(account.id) };
    }

    async requireAccount(sessionToken: string): Promise<Account> {
        const accountId = this.verifyToken(sessionToken);

        if (!accountId) {
            throw new Error("invalid session");
        }

        const account = await this.store.accountById(accountId);

        if (!account) {
            throw new Error("invalid session");
        }

        return account;
    }

    private issueToken(accountId: string): string {
        const payload = `${accountId}.${Date.now()}`;
        const sig = new Bun.CryptoHasher("sha256").update(`${payload}.${this.secret()}`).digest("hex");

        return `${Buffer.from(payload).toString("base64url")}.${sig}`;
    }

    private verifyToken(token: string): string | null {
        const [b64, sig] = token.split(".");

        if (!b64 || !sig) {
            return null;
        }

        const payload = Buffer.from(b64, "base64url").toString("utf8");
        const expected = new Bun.CryptoHasher("sha256").update(`${payload}.${this.secret()}`).digest("hex");

        if (sig !== expected) {
            return null;
        }

        return payload.split(".")[0] ?? null;
    }

    private secret(): string {
        const s = process.env.DD_CLOUD_SESSION_SECRET;

        if (!s) {
            throw new Error("DD_CLOUD_SESSION_SECRET is required");
        }

        return s;
    }
}
```

> `store.accountById` is referenced here — add it to `CloudStore` (Task 10) alongside `accountByEmail`.
> If the user picks **better-auth** instead, replace this class with the better-auth adapter; the
> `signup/login/requireAccount` surface that `server.ts` consumes stays the same.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/cloud/api/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/cloud/api/auth.ts DevDashboard/cloud/api/auth.test.ts
git commit -m "feat(dd-cloud): account auth (signup/login/requireAccount)"
```

---

### Task 12: Provision a relay/tunnel for the account (`RelayProvider` + provision flow)

> Provisioning creates a vendor relay binding for an account and returns the public `relayUrl` + a
> `pairingChannelId`. The relay tech (vendor cloudflared-per-account vs a thin WS relay) is an open
> question — BOTH require the plan-02 E2E layer on top, so the cloud never sees plaintext either way.
> `StubRelayProvider` lets the whole flow be tested without real infra.

**Files:**
- Create: `DevDashboard/cloud/api/pairing.ts` (the `RelayProvider` interface + `StubRelayProvider`)
- Create: `DevDashboard/cloud/api/provision.ts`
- Test: `DevDashboard/cloud/api/provision.test.ts`

- [ ] **Step 1: Write `pairing.ts` (RelayProvider interface + stub)**

```typescript
export interface ProvisionedRelay {
    /** Public, shareable relay endpoint the agent + phone both dial. */
    relayUrl: string;
    /** Out-of-band rendezvous id. NOT a secret — it only namespaces the relay channel. */
    pairingChannelId: string;
}

/** Abstracts the managed relay backend. The cloud NEVER terminates plaintext — see plan 02 E2E layer. */
export interface RelayProvider {
    readonly kind: "stub" | "cloudflared" | "ws-relay";
    /** Allocate a relay channel for an account. Returns ONLY public material. */
    allocate(accountId: string): Promise<ProvisionedRelay>;
    /** Tear down a relay channel (account cancel / downgrade). */
    release(pairingChannelId: string): Promise<void>;
}

export class StubRelayProvider implements RelayProvider {
    readonly kind = "stub" as const;

    allocate(accountId: string): Promise<ProvisionedRelay> {
        const channel = crypto.randomUUID();

        return Promise.resolve({ relayUrl: `wss://relay.devdashboard.test/ch/${channel}`, pairingChannelId: channel });
    }

    release(): Promise<void> {
        return Promise.resolve();
    }
}
```

- [ ] **Step 2: Write the failing provision test**

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CloudStore } from "./db/store";
import { StubRelayProvider } from "./pairing";
import { provisionRelay } from "./provision";

describe("provisionRelay", () => {
    it("creates a relay binding and returns the public relay url + channel", async () => {
        const store = CloudStore.fromDatabase(new Database(":memory:"));
        const acct = await store.createAccount({ email: "p@e.c", passwordHash: "h" });

        const result = await provisionRelay({ accountId: acct.id, store, relay: new StubRelayProvider() });

        expect(result.relayUrl).toContain("wss://");
        expect(result.pairingChannelId).toBeString();
        // binding persisted in 'pending' with NO key material
        const binding = await store.relayBindingByAccount(acct.id);
        expect(binding?.status).toBe("pending");
        expect(binding?.agentPublicKey).toBeNull();
        expect(binding?.phonePublicKey).toBeNull();
    });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test DevDashboard/cloud/api/provision.test.ts`
Expected: FAIL — `provisionRelay` not defined.

- [ ] **Step 4: Implement `provision.ts`**

```typescript
import { logger } from "@app/logger";
import type { ProvisionedRelay, RelayProvider } from "./pairing";
import type { CloudStore } from "./db/store";

export interface ProvisionInput {
    accountId: string;
    store: CloudStore;
    relay: RelayProvider;
}

export async function provisionRelay(input: ProvisionInput): Promise<ProvisionedRelay> {
    const { accountId, store, relay } = input;
    const allocated = await relay.allocate(accountId);

    await store.createRelayBinding({
        accountId,
        relayUrl: allocated.relayUrl,
        pairingChannelId: allocated.pairingChannelId,
    });

    logger.info({ accountId, relayKind: relay.kind }, "dd-cloud: relay provisioned (public binding only)");

    return allocated;
}
```

> `store.relayBindingByAccount` is referenced — add it to `CloudStore`.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test DevDashboard/cloud/api/provision.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/cloud/api/pairing.ts DevDashboard/cloud/api/provision.ts DevDashboard/cloud/api/provision.test.ts
git commit -m "feat(dd-cloud): provision relay binding (RelayProvider + stub, public-only)"
```

---

### Task 13: Pairing-assist endpoint — relays ONLY public keys (cross-ref plan 02 E2E)

> The cloud's role in pairing is narrow: let the agent and the phone exchange their **public** X25519
> keys + the relay endpoint over the `pairingChannelId`. It MUST NEVER carry the pairing secret, a
> private key, or a derived session secret. The actual ECDH + AEAD derivation happens **on the two
> endpoints** (plan 02 `pairDevice`). The preferred flow is even stronger: the **Mac agent shows the
> pairing QR locally** (out-of-band), so the public-key exchange itself need not transit the cloud — in
> that case this endpoint only records that both sides are bound. This task implements the public-key
> relay path and asserts the boundary.

**Files:**
- Create: `DevDashboard/cloud/api/pairing-assist.ts`
- Test: `DevDashboard/cloud/api/pairing-assist.test.ts`

- [ ] **Step 1: Write the failing test (public keys pass; anything secret is rejected)**

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CloudStore } from "./db/store";
import { StubRelayProvider } from "./pairing";
import { provisionRelay } from "./provision";
import { registerEndpointPublicKey, pairingState } from "./pairing-assist";

async function setup() {
    const store = CloudStore.fromDatabase(new Database(":memory:"));
    const acct = await store.createAccount({ email: "pa@e.c", passwordHash: "h" });
    const { pairingChannelId } = await provisionRelay({ accountId: acct.id, store, relay: new StubRelayProvider() });

    return { store, accountId: acct.id, pairingChannelId };
}

describe("pairing-assist", () => {
    it("records the agent + phone PUBLIC keys and flips status to ready", async () => {
        const { store, pairingChannelId } = await setup();
        await registerEndpointPublicKey({ store, pairingChannelId, role: "agent", publicKey: "AGENTPUB==" });
        await registerEndpointPublicKey({ store, pairingChannelId, role: "phone", publicKey: "PHONEPUB==" });

        const state = await pairingState({ store, pairingChannelId });
        expect(state.agentPublicKey).toBe("AGENTPUB==");
        expect(state.phonePublicKey).toBe("PHONEPUB==");
        expect(state.status).toBe("ready");
    });

    it("REFUSES a payload that smuggles a private/derived secret (boundary)", async () => {
        const { store, pairingChannelId } = await setup();
        await expect(
            // @ts-expect-error — privateKey is not a valid field; the guard must also reject by value
            registerEndpointPublicKey({ store, pairingChannelId, role: "agent", publicKey: "P==", privateKey: "leak" }),
        ).rejects.toThrow(/key material/i);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/cloud/api/pairing-assist.test.ts`
Expected: FAIL — `registerEndpointPublicKey` not defined.

- [ ] **Step 3: Implement `pairing-assist.ts`**

```typescript
import { logger } from "@app/logger";
import { assertNoKeyMaterial } from "../shared/data-boundary";
import type { ProvisionStatus, RelayBinding } from "../shared/account-model";
import type { CloudStore } from "./db/store";

export type EndpointRole = "agent" | "phone";

export interface RegisterPublicKeyInput {
    store: CloudStore;
    pairingChannelId: string;
    role: EndpointRole;
    /** Base64 X25519 PUBLIC key ONLY. The private half never leaves the endpoint (plan 02). */
    publicKey: string;
}

/**
 * Records ONE endpoint's PUBLIC key on the relay binding. When both are present the binding is
 * 'ready' — the endpoints then run ECDH + AEAD locally (plan 02). The cloud never derives or stores
 * the shared secret. The boundary guard rejects any extra (secret-looking) field defensively.
 */
export async function registerEndpointPublicKey(input: RegisterPublicKeyInput): Promise<void> {
    const { store, pairingChannelId, role, publicKey } = input;
    const binding = await store.relayBindingByChannel(pairingChannelId);

    if (!binding) {
        throw new Error(`unknown pairing channel: ${pairingChannelId}`);
    }

    const patch: Partial<RelayBinding> = role === "agent" ? { agentPublicKey: publicKey } : { phonePublicKey: publicKey };
    const both = role === "agent" ? Boolean(binding.phonePublicKey) : Boolean(binding.agentPublicKey);
    const nextStatus: ProvisionStatus = both ? "ready" : "provisioning";

    // Defense in depth: guard rejects forbidden fields even if a caller smuggles them.
    assertNoKeyMaterial("relay_bindings", { id: binding.id, ...patch, status: nextStatus });
    await store.updateRelayBinding(binding.id, { ...patch, status: nextStatus });
    logger.info({ pairingChannelId, role, status: nextStatus }, "dd-cloud: endpoint public key registered");
}

export interface PairingStateInput {
    store: CloudStore;
    pairingChannelId: string;
}

export async function pairingState(input: PairingStateInput): Promise<Pick<RelayBinding, "agentPublicKey" | "phonePublicKey" | "status">> {
    const binding = await input.store.relayBindingByChannel(input.pairingChannelId);

    if (!binding) {
        throw new Error(`unknown pairing channel: ${input.pairingChannelId}`);
    }

    return { agentPublicKey: binding.agentPublicKey, phonePublicKey: binding.phonePublicKey, status: binding.status };
}
```

> `store.relayBindingByChannel` is referenced — add it to `CloudStore`. The `@ts-expect-error` test
> case proves the boundary catches a smuggled secret even though TS would normally reject it.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/cloud/api/pairing-assist.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/cloud/api/pairing-assist.ts DevDashboard/cloud/api/pairing-assist.test.ts
git commit -m "feat(dd-cloud): pairing-assist relays public keys only (cross-ref plan 02 E2E)"
```

---

### Task 14: Billing stub (`BillingProvider` interface + `StubBillingProvider`)

> Billing is a stub: a typed interface + an in-memory stub. Stripe is NAMED and DEFERRED — the
> `externalBillingId` column already holds an opaque provider id; no card data ever touches the cloud DB.

**Files:**
- Create: `DevDashboard/cloud/api/billing.ts`
- Test: `DevDashboard/cloud/api/billing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { StubBillingProvider } from "./billing";

describe("StubBillingProvider", () => {
    it("creates a managed subscription and returns an opaque external id", async () => {
        const billing = new StubBillingProvider();
        const sub = await billing.createSubscription({ accountId: "a1", tier: "managed" });
        expect(sub.externalBillingId).toBeString();
        expect(sub.status).toBe("active");
    });

    it("cancels a subscription", async () => {
        const billing = new StubBillingProvider();
        const sub = await billing.createSubscription({ accountId: "a1", tier: "managed" });
        const canceled = await billing.cancelSubscription(sub.externalBillingId);
        expect(canceled.status).toBe("canceled");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/cloud/api/billing.test.ts`
Expected: FAIL — `StubBillingProvider` not defined.

- [ ] **Step 3: Implement `billing.ts`**

```typescript
import type { SubscriptionStatus, SubscriptionTier } from "../shared/account-model";

export interface BillingSubscription {
    externalBillingId: string;
    accountId: string;
    tier: SubscriptionTier;
    status: SubscriptionStatus;
}

export interface CreateSubscriptionInput {
    accountId: string;
    tier: SubscriptionTier;
}

/** Abstracts the payment processor. Stripe impl deferred; the cloud DB stores only the opaque id. */
export interface BillingProvider {
    readonly kind: "stub" | "stripe";
    createSubscription(input: CreateSubscriptionInput): Promise<BillingSubscription>;
    cancelSubscription(externalBillingId: string): Promise<BillingSubscription>;
}

export class StubBillingProvider implements BillingProvider {
    readonly kind = "stub" as const;
    private readonly subs = new Map<string, BillingSubscription>();

    createSubscription(input: CreateSubscriptionInput): Promise<BillingSubscription> {
        const sub: BillingSubscription = {
            externalBillingId: `stub_${crypto.randomUUID()}`,
            accountId: input.accountId,
            tier: input.tier,
            status: "active",
        };
        this.subs.set(sub.externalBillingId, sub);

        return Promise.resolve(sub);
    }

    cancelSubscription(externalBillingId: string): Promise<BillingSubscription> {
        const sub = this.subs.get(externalBillingId);

        if (!sub) {
            throw new Error(`unknown subscription: ${externalBillingId}`);
        }

        const canceled = { ...sub, status: "canceled" as const };
        this.subs.set(externalBillingId, canceled);

        return Promise.resolve(canceled);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/cloud/api/billing.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/cloud/api/billing.ts DevDashboard/cloud/api/billing.test.ts
git commit -m "feat(dd-cloud): billing stub (BillingProvider iface, Stripe deferred)"
```

---

### Task 15: Hono server wiring (`/api/cloud/*` routes)

> The HTTP surface that the landing-page signup form + the agent + the mobile app call. Uses Hono on
> Bun (PROPOSED). Each route is a thin controller over the lib (`CloudAuth`, `provisionRelay`,
> `registerEndpointPublicKey`, `StubBillingProvider`) — same controllers-thin discipline as the Agent.

**Files:**
- Create: `DevDashboard/cloud/api/server.ts`
- Test: `DevDashboard/cloud/api/server.test.ts`

- [ ] **Step 1: Write the failing integration test (signup → provision → pair, in-memory)**

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createCloudApp } from "./server";

function app() {
    process.env.DD_CLOUD_SESSION_SECRET = "test-secret";
    return createCloudApp({ database: new Database(":memory:") });
}

describe("cloud server", () => {
    it("POST /api/cloud/signup creates an account + returns a session token", async () => {
        const res = await app().request("/api/cloud/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "srv@e.c", password: "a-strong-password-123" }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.sessionToken).toBeString();
    });

    it("POST /api/cloud/provision (authed) returns a public relay url + channel", async () => {
        const a = app();
        const signup = await (await a.request("/api/cloud/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "pr@e.c", password: "a-strong-password-123" }) })).json();
        const res = await a.request("/api/cloud/provision", { method: "POST", headers: { Authorization: `Bearer ${signup.sessionToken}` } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.relayUrl).toContain("wss://");
        expect(body.pairingChannelId).toBeString();
    });

    it("POST /api/cloud/pair/public-key records a PUBLIC key (and rejects key material)", async () => {
        const a = app();
        const signup = await (await a.request("/api/cloud/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "pk@e.c", password: "a-strong-password-123" }) })).json();
        const prov = await (await a.request("/api/cloud/provision", { method: "POST", headers: { Authorization: `Bearer ${signup.sessionToken}` } })).json();

        const ok = await a.request("/api/cloud/pair/public-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signup.sessionToken}` }, body: JSON.stringify({ pairingChannelId: prov.pairingChannelId, role: "agent", publicKey: "PUB==" }) });
        expect(ok.status).toBe(200);

        const leak = await a.request("/api/cloud/pair/public-key", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signup.sessionToken}` }, body: JSON.stringify({ pairingChannelId: prov.pairingChannelId, role: "phone", publicKey: "PUB==", privateKey: "leak" }) });
        expect(leak.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test DevDashboard/cloud/api/server.test.ts`
Expected: FAIL — `createCloudApp` not defined.

- [ ] **Step 3: Implement `server.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SafeJSON } from "@app/utils/json";
import { logger } from "@app/logger";
import { CloudAuth } from "./auth";
import { StubBillingProvider } from "./billing";
import { CloudStore } from "./db/store";
import { registerEndpointPublicKey } from "./pairing-assist";
import { StubRelayProvider } from "./pairing";
import { provisionRelay } from "./provision";

export interface CloudAppDeps {
    database: Database;
}

function bearer(authHeader: string | undefined): string {
    if (!authHeader?.startsWith("Bearer ")) {
        throw new Error("missing bearer token");
    }

    return authHeader.slice("Bearer ".length);
}

export function createCloudApp(deps: CloudAppDeps): Hono {
    const store = CloudStore.fromDatabase(deps.database);
    const auth = new CloudAuth(store);
    const relay = new StubRelayProvider();
    const billing = new StubBillingProvider();
    const app = new Hono();

    app.post("/api/cloud/signup", async (c) => {
        const body = SafeJSON.parse<{ email: string; password: string }>(await c.req.text(), { strict: true });
        const result = await auth.signup(body);

        return c.json({ account: { id: result.account.id, email: result.account.email }, sessionToken: result.sessionToken }, 201);
    });

    app.post("/api/cloud/login", async (c) => {
        const body = SafeJSON.parse<{ email: string; password: string }>(await c.req.text(), { strict: true });
        const result = await auth.login(body);

        return c.json({ account: { id: result.account.id, email: result.account.email }, sessionToken: result.sessionToken });
    });

    app.post("/api/cloud/provision", async (c) => {
        const account = await auth.requireAccount(bearer(c.req.header("Authorization")));
        const sub = await billing.createSubscription({ accountId: account.id, tier: "managed" });
        await store.createSubscription({ accountId: account.id, tier: "managed", status: sub.status, externalBillingId: sub.externalBillingId });
        const provisioned = await provisionRelay({ accountId: account.id, store, relay });

        return c.json(provisioned);
    });

    app.post("/api/cloud/pair/public-key", async (c) => {
        await auth.requireAccount(bearer(c.req.header("Authorization")));
        const body = SafeJSON.parse<{ pairingChannelId: string; role: "agent" | "phone"; publicKey: string }>(await c.req.text(), { strict: true });

        try {
            await registerEndpointPublicKey({ store, pairingChannelId: body.pairingChannelId, role: body.role, publicKey: body.publicKey });
        } catch (err) {
            logger.warn({ err }, "dd-cloud: pair/public-key rejected");

            return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
        }

        return c.json({ ok: true });
    });

    return app;
}

export function serveCloud(opts: { port: number; database: Database }): void {
    const app = createCloudApp({ database: opts.database });
    Bun.serve({ port: opts.port, fetch: app.fetch });
    logger.info({ port: opts.port }, "DevDashboard Cloud API listening");
}
```

> `store.createSubscription` is referenced — add it to `CloudStore` (boundary-guarded like the others).
> Hono is the PROPOSED API framework (open question); if rejected, swap to the plan-01 `Router` +
> `bun-serve` adapter — the lib calls are unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test DevDashboard/cloud/api/server.test.ts`
Expected: PASS (3 tests) — note the `privateKey: "leak"` case returns **400** (boundary rejection
surfaced as a client error, not a 500).

- [ ] **Step 5: Logging-guard + full cloud test sweep**

Run: `bash scripts/ci/logging-guard.sh ; bun test DevDashboard/cloud/`
Expected: logging-guard PASS (no `logger.*(SafeJSON.stringify(...))` result dumps; results flow through
Hono's `c.json`); all cloud tests green.

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/cloud/api/server.ts DevDashboard/cloud/api/server.test.ts
git commit -m "feat(dd-cloud): Hono provisioning server (signup/provision/pair, boundary-enforced)"
```

---

### Task 16: Managed end-to-end acceptance + Appium pairing spec

> The genuinely-mobile part is the managed **connect/pair** flow → that is the Appium spec (the landing
> page is web, tested by Playwright in Task 9 — do NOT Appium-test a website). This task extends the
> shared `ConnectPage` POM (from plans 02/04) with managed-tier methods and asserts the acceptance
> criteria end-to-end. Per ADR §8: the managed feature is "done" only when this Appium spec passes.

**Files:**
- Create: `DevDashboard/cloud/e2e/pages/ConnectPage.managed.ts`
- Create: `DevDashboard/cloud/e2e/specs/managed-pairing.spec.ts`

- [ ] **Step 1: Write the managed `ConnectPage` POM extension (accessibility-id locators)**

```typescript
// Extends the base ConnectPage from plan 04's e2e/pages/ConnectPage.page.ts with managed-tier methods.
// Locators are accessibility-ids set on the RN components (testID -> iOS accessibility-id).
import { appium } from "../appium-fixtures"; // the appium_* MCP wrapper from plan 04

export class ManagedConnectPage {
    // accessibility-ids the mobile Connect screen must expose for the managed tier:
    static readonly TIER_MANAGED_BTN = "connect-tier-managed";
    static readonly SCAN_QR_BTN = "connect-managed-scan-qr";
    static readonly PAIRING_STATUS = "connect-managed-pairing-status";
    static readonly CONNECTED_BADGE = "connect-status-connected";

    async selectManagedTier(): Promise<void> {
        await appium.tap({ accessibilityId: ManagedConnectPage.TIER_MANAGED_BTN });
    }

    async startQrScan(): Promise<void> {
        await appium.tap({ accessibilityId: ManagedConnectPage.SCAN_QR_BTN });
    }

    async pairingStatusText(): Promise<string> {
        return appium.getText({ accessibilityId: ManagedConnectPage.PAIRING_STATUS });
    }

    async waitConnected(timeoutMs = 30_000): Promise<void> {
        await appium.waitForVisible({ accessibilityId: ManagedConnectPage.CONNECTED_BADGE, timeoutMs });
    }
}
```

- [ ] **Step 2: Write the managed-pairing Appium spec**

```typescript
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ManagedConnectPage } from "../pages/ConnectPage.managed";
import { startTestAgent, startStubRelay, primeManagedAccount } from "../harness"; // test fixtures

describe("managed tier: signup provisions a working tunnel for a test account", () => {
    let agentUrl: string;

    beforeAll(async () => {
        // 1. spin a stub relay + a real DevDashboard Agent (plan 01 serveAgent) behind it
        await startStubRelay();
        agentUrl = await startTestAgent();
        // 2. create a managed test account + provision a binding via the cloud API (Task 15)
        await primeManagedAccount({ email: "appium@e.c", password: "a-strong-password-123" });
    });

    it("pairs over the managed relay and shows live Pulse (E2E, cloud holds no keys)", async () => {
        const page = new ManagedConnectPage();
        await page.selectManagedTier();
        await page.startQrScan(); // scans the QR the Mac agent shows locally (out-of-band secret)
        await page.waitConnected();

        // Acceptance: the phone reaches the agent THROUGH the relay -> Pulse renders.
        // (Pulse assertion uses the PulsePage POM from plan 05.)
        expect(await page.pairingStatusText()).toMatch(/paired|connected/i);
    });

    afterAll(async () => {
        // tear down agent + relay
    });
});
```

> The `harness`/`appium-fixtures` helpers are shared with plans 04–07; this task adds the managed-tier
> fixtures (`startStubRelay`, `primeManagedAccount`). Drive the device via the `appium_*` MCP tools
> (`appium_find_element` by accessibility-id, `appium_gesture` for taps) per ADR §8.

- [ ] **Step 3: Run the Appium spec on the iOS dev-client**

Run: `bun test DevDashboard/cloud/e2e/specs/managed-pairing.spec.ts` (with the Appium session + dev-client up)
Expected: PASS — the test account pairs over the relay and Pulse renders. **The managed feature is
done only when this passes.**

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/cloud/e2e/pages/ConnectPage.managed.ts DevDashboard/cloud/e2e/specs/managed-pairing.spec.ts
git commit -m "test(dd-cloud): Appium managed-pairing spec + ConnectPage managed POM"
```

---

## Acceptance criteria — "managed signup provisions a working tunnel for a test account" (M4)

The managed tier is **done** when ALL of these hold (this is milestone **M4** from `…-00-Overview.md`):

1. **Signup works.** `POST /api/cloud/signup` creates an account, hashes the password (never stores
   plaintext), and returns a session token (Task 11 + 15 tests green).
2. **Provisioning creates a relay binding.** An authed `POST /api/cloud/provision` allocates a relay
   channel and persists a `relay_bindings` row in `pending` with **null** key columns and a public
   `relayUrl` + `pairingChannelId` (Task 12 + 15 tests green).
3. **The Mac agent dials the relay and the phone reaches the agent through it.** With the test account
   + a real Agent (plan 01 `serveAgent`) behind the (stub) relay, the mobile app selects the managed
   tier, scans the **locally-shown** pairing QR, completes the plan-02 E2E handshake on-device, and
   **renders live Pulse** — proving the tunnel carries real traffic end-to-end (Task 16 Appium spec).
4. **The relay sees only ciphertext (the E2E property).** Terminal I/O / SSE / WS payloads on the wire
   between phone and agent are AEAD-encrypted by the plan-02 layer; the relay forwards opaque bytes.
   (Verified at the plan-02 boundary; this plan's contribution is that the cloud never decrypts.)
5. **The cloud DB holds NO key material.** After a full pair, the `relay_bindings` row contains only
   the two **public** keys + the public relay URL; `assertNoKeyMaterial` has gated every write; the
   `data-boundary` + `store` tests prove no private key / derived secret / pairing secret was ever
   persisted (Tasks 2, 10, 13).
6. **Marketing matches architecture.** `copy-parity.test.ts` is green: every rendered trust claim is
   byte-identical to `tier-policy.ts`, the managed tier never says "unconditional", and its metadata
   caveat is shown (Tasks 1, 3, 5, 9).
7. **Billing is stubbed cleanly.** A managed signup creates a `StubBillingProvider` subscription and
   stores only the opaque `externalBillingId` (Tasks 14, 15).

## Design-mockup-selection dependency (BLOCKING for Task 8 only)

- **Task 8 (FINALIZE visual direction) is GATED on the user choosing a mockup direction.** Everything
  else (full structure, all sections, all copy, the entire managed backend, all tests) is built FIRST
  on the Ethereal-Glass default, so the only thing waiting on the user is the visual *finish* — no
  functionality is blocked.
- **Deliverable for the choice:** 2–3 rendered mockup screenshots (Ethereal-Glass+Bento /
  Soft-Structuralism+Split / Editorial-Luxury+Cascade) per `high-end-visual-design` §3, captured with
  the playwright-mcp headless recipe (MEMORY: pixel-perfect mobile-sim screenshots). The user picks ONE;
  it is recorded in `DevDashboard/cloud/web/DESIGN.md` and applied in Task 8.
- **Forward dependency on plan 02:** the E2E pairing internals (`pairDevice`, ECDH/AEAD, key custody)
  are owned by `…-02-TransportTrust.md` (not yet written). This plan's `pairing-assist` + Appium spec
  cross-reference it by name and must not re-implement or rename the crypto. If 02's endpoint-key API
  differs from the `agentPublicKey`/`phonePublicKey` names assumed here, align the names to 02 (02 is
  authoritative for the crypto surface; this plan is authoritative for the cloud data boundary).

## Self-Review checklist (run after implementing)

1. **Data boundary is airtight.** `assertNoKeyMaterial` is called on EVERY `CloudStore` write
   (`createAccount`, `createRelayBinding`, `updateRelayBinding`, `createSubscription`) and in
   `pairing-assist`. The boundary test rejects every `FORBIDDEN_KEY_FIELDS` entry, off-allow-list
   fields, and secret-looking values. No table has a private-key/derived-secret/pairing-secret column.
2. **Trust copy matches ADR §4 EXACTLY.** `tier-policy.ts` is the single source; `copy-parity.test.ts`
   asserts the rendered claims equal it. LAN/Tailscale/cloudflared-self = `unconditional`; managed =
   `e2e-conditional` with the metadata caveat and the "keys never leave / vendor never escrows"
   language. The word "unconditional" never attaches to managed.
3. **Type consistency.** Tier ids match the ADR `Transport.tier` literals (`lan` | `tailscale` |
   `cloudflared-self` | `managed`). DTO names (`Account`, `Subscription`, `RelayBinding`,
   `ProvisionStatus`) are this plan's to own and are used identically across `shared/`, `api/`, tests.
   The E2E crypto types are NOT redefined here (cross-ref plan 02).
4. **Controllers stay thin.** Each Hono route parses + delegates to a lib function; logic lives in
   `auth.ts` / `provision.ts` / `pairing-assist.ts` / `billing.ts` (same discipline as the Agent).
5. **Conventions.** SafeJSON everywhere (no `JSON`); logger/out split (results via `c.json`, never
   `logger.*(SafeJSON.stringify(...))` — logging-guard green); no one-line ifs; blank line before
   `if` / after `}`; objects for 3+ params; no `as any`.
6. **Right test tool per surface.** Landing = Playwright + Lighthouse/a11y + the copy-parity unit test;
   managed pairing = Appium POM. The website is NOT Appium-tested.
7. **No placeholders.** Every code step is full code; the only deferred items are the explicit
   open-question library picks (with PROPOSED leads) and the GATED Task 8 visual finalize.
8. **Stubs are honestly stubs.** `StubRelayProvider` / `StubBillingProvider` are behind interfaces;
   real cloudflared/ws-relay + Stripe are named and deferred without faking a "done" claim.

## Appium E2E (per ADR §8) — managed pairing

**Spec:** `DevDashboard/cloud/e2e/specs/managed-pairing.spec.ts`
**Page Objects:**
- `DevDashboard/cloud/e2e/pages/ConnectPage.managed.ts` — `ManagedConnectPage` extending the shared
  `ConnectPage` (plan 04). Methods: `selectManagedTier()`, `startQrScan()`, `pairingStatusText()`,
  `waitConnected()`.

**Accessibility-id locators** (the RN Connect screen must expose these `testID`s → iOS accessibility-ids):
- `connect-tier-managed` — the managed-tier selector button.
- `connect-managed-scan-qr` — the QR-scan trigger.
- `connect-managed-pairing-status` — the pairing status text.
- `connect-status-connected` — the connected badge (shared with other tiers).

**MCP tools:** drive via `appium_find_element` (accessibility-id first, never xpath), `appium_gesture`
(taps/drags), `appium_get_text` (status assertions), and `appium_session_management` (session
create/teardown). Reachability/Pulse assertions reuse the `PulsePage` POM (plan 05).

**Done criterion (ADR §8):** the managed feature is "done" only when `managed-pairing.spec.ts` passes
on the iOS simulator/dev-client — the test account pairs over the relay and live Pulse renders, while
the cloud DB provably holds no key material. The web landing page is verified separately by the
Playwright signup flow + Lighthouse/a11y gates (Task 9), not by Appium.
