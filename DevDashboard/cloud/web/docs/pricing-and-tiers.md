# Pricing & Tiers

> **The one rule:** *you never pay for privacy.* Privacy is the floor on every tier, including Free.
> Paid tiers buy **convenience** (one-tap managed remote, push alerts) and **scale** (fleet, teams,
> audit, SSO) — never the ability to keep your data to yourself. That's already yours.

There are two things to choose here, and they're independent:

1. A **plan** — what features and how much convenience you get (Free / Pro / Team).
2. A **transport** — how your phone reaches your Mac, and the exact trust profile that comes with it
   (LAN / Tailscale / self-hosted tunnel / managed).

---

## Plans

These map directly to the plan cards on the landing page and the signup flow
(`/signup?plan=free|pro|team`).

### Free — *Self-host* · **$0 forever**

Everything works, fully private, forever — you bring your own pipe.

- Terminals, Pulse, QA, Obsidian.
- LAN + Tailscale transports.
- Your own Cloudflare tunnel (guided wizard).
- 1 device.

*Pitch: "Everything works, fully private, forever. Bring your own pipe."*

### Pro — *Managed remote + E2E* · **$8/mo, billed yearly**

For when you don't want to run your own networking. We do the relay and the pinging; you still hold
the keys.

- **Everything in Free.**
- One-tap **managed remote**, with app-layer end-to-end encryption.
- Managed sub-domain (`your-name.devdashboard.app` — no domain of your own needed).
- Push alerts (agent-needs-input, build/CI, thresholds, long-job done) + **unlimited devices**.

*Pitch: "We do the networking and the pinging. You still hold the keys."*

### Team — *For on-call & agencies* · **$24/mo, per seat**

Your whole fleet on every phone, cleanly separated.

- **Everything in Pro.**
- Shared machines + role-based access.
- On-call routing + audit log.
- SSO + priority support.

*Pitch: "Your whole fleet on every phone, cleanly separated."*

> **Enterprise** (governance & self-host support, annual) adds SSO/SAML-OIDC, audit-log export,
> role-based machine access, and a self-host support contract for running the managed relay inside
> your own perimeter. Talk to us.

---

## The trust-tier matrix

The plan you pick gates *which transports are available*. The transport you use determines *who can
see what*. This is the part that doesn't drift: every claim below is generated from the single
source of truth ([`shared/tier-policy.ts`](../../shared/tier-policy.ts)) that the landing page
renders and a test asserts against the architecture (D11).

### Local network — *Same Wi-Fi, zero third parties.*

- **No-see:** unconditional.
- **Claim:** *Nothing leaves your network. We cannot see your data — there is no relay, no edge, no
  vendor in the path.*
- **Setup:** auto-discovers your Mac on the same Wi-Fi. No account, no setup.
- **Badge:** Zero third party.

### Tailscale / WireGuard — *Remote access, end-to-end encrypted.*

- **No-see:** unconditional.
- **Claim:** *Your phone and Mac speak WireGuard end-to-end. Relays see only ciphertext — we cannot
  see your data, by construction.*
- **Setup:** install the Tailscale app and sign in. We detect your tailnet and connect — we never
  touch your keys.
- **Badge:** Trust-max.

### Self-hosted tunnel — *One-command tunnel on your own account.*

- **No-see:** unconditional (vendor never in the path).
- **Claim:** *The tunnel runs on your own Cloudflare account, not ours — so the vendor can't see
  your data.*
- **Caveat:** Cloudflare terminates TLS at its edge, as with any Cloudflare tunnel.
- **Setup:** run `tools dev-dashboard tunnel setup` — it installs cloudflared, walks the login, and
  prints a pairing QR. No copy-paste.
- **Badge:** Self-hosted · guided wizard.

### Managed (one-tap) — *We set everything up. Keys stay on your devices.*

- **No-see:** conditional — true **via the end-to-end-encryption layer**, not despite it.
- **Claim:** *One tap, no setup. Because our relay terminates the transport, your data stays private
  only through end-to-end encryption above it: keys are generated on your phone and Mac and never
  leave them — the vendor never escrows them. The relay forwards opaque ciphertext.*
- **Caveat:** the relay still sees connection **metadata** (timing, sizes, endpoints) — *not your
  data.*
- **Setup:** sign up, scan one QR shown by your Mac agent. We provision the relay; the pairing
  secret never passes through us.
- **Badge:** One-tap · app-layer E2E.

> **"Unconditional" vs "conditional" no-see.** The first three tiers are no-see *by construction* —
> there's nothing to trust because the vendor literally isn't in the data path (or only ever sees
> ciphertext). Managed is no-see *via the E2E layer*: a relay is present, so the guarantee comes
> from the encryption above it, plus an honest metadata caveat. We never claim managed is
> "unconditional" — that distinction is the whole point.

---

## How to choose

| You want… | Plan | Transport |
|---|---|---|
| Phone access on the same Wi-Fi, free | Free | Local network |
| Remote access, max trust, free | Free | Tailscale / WireGuard |
| Remote access on your own infra, free | Free | Self-hosted tunnel |
| Remote access with zero setup + push alerts | Pro | Managed (one-tap) |
| A subdomain when you don't own a domain | Pro | Managed (+ managed subdomain) |
| Many machines, on-call, a team | Team | Any |

---

## Next steps

- **[Install the Agent](./install-the-agent.md)** — set up the transport you chose.
- **[Security & Trust](./security-and-trust.md)** — the no-see story and how to verify it.
- **[Getting Started](./getting-started.md)** — the full first-run walkthrough.
- **Billing showing "not configured"?** → **[Troubleshooting](./troubleshooting.md#billing-shows-not-configured)**.
