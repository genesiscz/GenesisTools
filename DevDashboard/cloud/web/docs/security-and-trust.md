# Security & Trust

> **Your machine. Your keys. We can't see your data — and you can prove it.**

That sentence is the whole product. This page explains *why* it's true, *what* the cloud can and
can't hold, and *how you verify it yourself* rather than taking our word for it. Every claim here is
backed by code you can read, not marketing.

---

## The promise, precisely

Privacy is the **floor**, not a feature you pay for. On every tier — including Free — the privacy
guarantee is a property of the **architecture**, not a marketing line. Paid tiers buy convenience
and scale, never the ability to keep your data to yourself. See [Pricing & Tiers](./pricing-and-tiers.md).

The guarantee comes in two strengths, and we're explicit about which one each transport gives you:

- **Unconditional no-see** — true *by construction*. The vendor is not in the data path, or only
  ever sees ciphertext. There's nothing to trust. (LAN, Tailscale/WireGuard, self-hosted tunnel.)
- **Conditional (E2E) no-see** — true *via the end-to-end-encryption layer*. A relay is present, so
  the guarantee comes from the encryption above it, plus an honest metadata caveat. (Managed.)

We never claim managed remote is "unconditional." That distinction is deliberate and load-bearing.

---

## What the cloud stores

The cloud app handles accounts, plans, managed subdomains, and device registration. It stores
**public keys only** — never any private/secret material.

This is enforced in code by a non-negotiable **data boundary**
([`shared/data-boundary.ts`](../../shared/data-boundary.ts)): every write into a cloud table passes
through `assertNoKeyMaterial`, which throws if a record contains any forbidden key field **or** any
field outside that table's allow-list.

Forbidden fields — a write containing any of these throws immediately:

```
privateKey   secretKey     sessionKey    sharedSecret   derivedSecret
pairingSecret  symmetricKey  aeadKey      nonceSecret
```

| The cloud holds | The cloud never holds |
|---|---|
| Account email, plan/subscription | Private keys (X25519, session, AEAD) |
| Each device's **public** key | The pairing secret |
| Claimed managed subdomain name | Derived/shared session secrets |
| Push-alert preferences | Terminal contents, keystrokes, output |
| | Pulse metrics, Obsidian notes, logs, files |

The E2E crypto itself lives entirely on the two endpoints — your **phone** and your **Mac agent**.
The cloud never holds private keys, derived session secrets, or the pairing secret.

---

## The data boundary

Why a code-enforced boundary instead of a policy? Because a promise you can grep beats a promise you
read in a privacy page.

- Every domain write goes through `cloudStore`, and every `cloudStore` write calls
  `assertNoKeyMaterial(table, record)`.
- The allow-list is per-table (`CLOUD_PERSISTABLE_FIELDS`). A field not on the list — even an
  innocent one — is rejected, so the surface can't silently grow to leak something later.
- Device pairing records the device's **public** key plus an out-of-band **device code** (proof your
  Mac agent consents). The cloud never validates or decrypts the pairing secret; the real handshake
  (X25519 ECDH → per-message AEAD) happens phone ↔ Mac, never through the cloud.

This is tested: [`shared/data-boundary.test.ts`](../../shared/data-boundary.test.ts) asserts the
guard rejects forbidden and off-list fields.

---

## The four transports, in the vendor's own words

These claims are generated from the single source of truth
([`shared/tier-policy.ts`](../../shared/tier-policy.ts)), which a parity test asserts against the
architecture (D11) so the marketing can never drift from reality.

### Local network — *unconditional no-see*

> Nothing leaves your network. We cannot see your data — there is no relay, no edge, no vendor in
> the path.

### Tailscale / WireGuard — *unconditional no-see*

> Your phone and Mac speak WireGuard end-to-end. Relays see only ciphertext — we cannot see your
> data, by construction.

### Self-hosted tunnel — *unconditional no-see (vendor never in the path)*

> The tunnel runs on your own Cloudflare account, not ours — so the vendor can't see your data.
> (Cloudflare terminates TLS at its edge, as with any Cloudflare tunnel.)

### Managed (one-tap) — *conditional (E2E) no-see*

> One tap, no setup. Because our relay terminates the transport, your data stays private only through
> end-to-end encryption above it: keys are generated on your phone and Mac and never leave them — the
> vendor never escrows them. The relay forwards opaque ciphertext.

> **Managed caveat (always surfaced in-app):** the relay still sees connection **metadata** (timing,
> sizes, endpoints) — *not your data.*

---

## Verify it yourself

The "and you can prove it" is not rhetorical. Three independent ways to confirm:

1. **Safety numbers (key fingerprints).** On a managed connection, the app shows a fingerprint on
   both your phone and your Mac. Compare them out-of-band — exactly like verifying a contact in an
   end-to-end-encrypted chat. Matching fingerprints confirm the channel is genuinely end-to-end and
   the relay carries only ciphertext. Do this the first time you pair over managed remote.

2. **Read the code.** The protocol is open and the clients are auditable. You can read the handshake,
   inspect the data boundary (`assertNoKeyMaterial`), and confirm the relay only ever carries
   ciphertext. The trust strings on the landing page are literally derived from
   [`shared/tier-policy.ts`](../../shared/tier-policy.ts), and a test pins them to the architecture.

3. **Choose a transport with no vendor at all.** On LAN, Tailscale, or your own Cloudflare tunnel,
   the vendor isn't in the data path — there's nothing to trust because there's nothing there. If
   even the managed metadata caveat is too much for your threat model, self-host.

---

## For security teams

- **No key escrow.** Pairing keys are generated on-device (phone's secure enclave + the Mac) and
  never leave them. The vendor cannot reconstruct a session.
- **Self-host the relay.** The managed relay can run inside your own perimeter (Enterprise), so even
  metadata stays in-house.
- **Auditability.** The E2E pairing flow, the fingerprint-verification UX, and key-handling docs are
  available as security-review artifacts. Team/Enterprise add an exportable audit log of remote
  actions.
- **Architecture references:** `DECISIONS.md` (D9–D11) and the ADR §4 define the trust model
  verbatim; the tier-policy test enforces parity.

---

## Next steps

- **[Install the Agent](./install-the-agent.md)** — pick a transport and pair, with the data
  boundary in context.
- **[Pricing & Tiers](./pricing-and-tiers.md)** — the full trust-tier matrix.
- **[Getting Started](./getting-started.md)** — the first-run walkthrough, including safety-number
  verification.
