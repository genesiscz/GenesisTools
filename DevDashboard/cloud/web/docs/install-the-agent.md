# Install the Agent

The **DevDashboard Agent** is the on-device server that runs on your Mac. It serves your live
terminals (tmux/cmux via ttyd), system Pulse metrics, the QA/agent stream, and the rest — directly
to your phone, over a transport you choose. The cloud app is *not* in this data path; the agent and
your phone talk to each other.

> **Where your data lives.** Terminals, metrics, and session output flow **agent ↔ phone**. The
> cloud only ever holds account info and each device's **public key**. See
> [Security & Trust](./security-and-trust.md).

---

## Start the agent

One command:

```bash
devdash agent start
```

> Inside GenesisTools the agent is also available as `tools dev-dashboard agent`.

On start, the agent serves your terminals and Pulse **locally** — nothing leaves the machine until
you choose a transport and pair a device. You should leave it running (or run it under a process
manager) for as long as you want phone access.

---

## Pick a transport

The transport is *how* your phone reaches your Mac. DevDashboard ships four, behind one switchable
interface — you choose the trust profile, and at every tier the privacy promise is a property of the
architecture, not a marketing line. (Full claim semantics:
[Pricing & Tiers — Trust matrix](./pricing-and-tiers.md#the-trust-tier-matrix) and
[Security & Trust](./security-and-trust.md).)

### Local network (LAN / mDNS)

- **Best for:** same Wi-Fi, fastest, zero setup, learning.
- **Setup:** the app auto-discovers your Mac on the same Wi-Fi. No account, no port-forwarding.
- **Trust:** *Nothing leaves your network.* There is no relay, no edge, no vendor in the path —
  unconditional no-see.

### Tailscale / WireGuard

- **Best for:** remote access with maximum trust ("trust-max").
- **Setup:** install the Tailscale app and sign in. The agent detects your tailnet and connects —
  it never touches your Tailscale keys.
- **Trust:** your phone and Mac speak WireGuard end-to-end. Relays see only ciphertext, by
  construction — unconditional no-see.

### Self-hosted Cloudflare tunnel

- **Best for:** remote access on your own infrastructure, no Tailscale.
- **Setup:** one guided command —
  ```bash
  tools dev-dashboard tunnel setup
  ```
  It installs `cloudflared`, walks you through the Cloudflare login, and prints a pairing QR. No
  copy-paste.
- **Trust:** the tunnel runs on **your own** Cloudflare account, not the vendor's — so the vendor
  can't see your data. (Cloudflare terminates TLS at its edge, as with any Cloudflare tunnel — the
  one caveat for this tier.)

### Managed (one-tap)

- **Best for:** zero-config remote with no networking to set up. **Pro tier.**
- **Setup:** sign up, then scan one QR shown by your Mac agent. The cloud provisions the relay; the
  pairing secret never passes through it.
- **Trust:** because the relay terminates the transport, your data stays private **through the
  end-to-end-encryption layer above it**: keys are generated on your phone and Mac and never leave
  them — the vendor never escrows them. The relay forwards opaque ciphertext.
  - **Caveat:** the relay still sees connection **metadata** (timing, sizes, endpoints) — *not your
    data.* This is the honest difference between managed and the self-host tiers.

> You can switch transports any time from the mobile app — the agent supports all four at once.

---

## Pair your phone

Pairing links one phone (or another device) to your agent and establishes the end-to-end channel.

1. With the agent running and a transport chosen, the agent (or the tunnel wizard) shows a
   **pairing QR**.
2. To register a device against your cloud account out-of-band, the agent prints a short
   **device code**:
   ```bash
   tools dev-dashboard pair
   ```
   The device code is proof that *your Mac agent consents* — the cloud never validates or decrypts
   the pairing secret itself.
3. In the mobile app, **scan the QR**. Your phone and Mac each generate an X25519 keypair on-device
   and perform the ECDH handshake → per-message AEAD. Keys live only on the two devices.
4. When you pair via the dashboard's Setup wizard, you provide the device **label**, **kind**
   (`phone` or `agent`), its **public key**, and the **device code**. The cloud records the
   **public key only** — never any private/secret/session/pairing material (enforced by the
   [data boundary](./security-and-trust.md#the-data-boundary)).

Paired devices appear under `/dashboard/devices`, where you can rename or remove them.

---

## Verify the channel (safety numbers)

The first time you pair over a transport with a relay in the middle (managed), **verify the safety
number**. The app shows a key fingerprint on both your phone and your Mac — compare them, like
verifying a contact in an end-to-end-encrypted chat. Matching fingerprints confirm the channel is
genuinely end-to-end and the relay only ever sees ciphertext.

See [Security & Trust — Verify it yourself](./security-and-trust.md#verify-it-yourself).

---

## What does and doesn't leave your machine

| Stays on your Mac / phone | What the cloud can hold |
|---|---|
| Terminal contents, keystrokes, command output | Your account (email, plan) |
| Pulse metrics (CPU/mem/disk/Wi-Fi/…) | Each device's **public** key |
| QA / agent session output | A claimed managed subdomain name |
| Obsidian notes, file contents, logs | Push-alert preferences |
| **All private keys, the pairing secret, derived session secrets** | (nothing in this column ever) |

The right column is allow-listed and enforced in code (`assertNoKeyMaterial`); a write that tries to
include anything outside it throws. The full list and rationale are in
[Security & Trust](./security-and-trust.md#what-the-cloud-stores).

---

## Next steps

- **[Getting Started](./getting-started.md)** — the end-to-end first-run walkthrough.
- **[Pricing & Tiers](./pricing-and-tiers.md)** — which transport each plan unlocks.
- **[Security & Trust](./security-and-trust.md)** — the no-see story in full.
- **Agent or pairing not behaving?** → **[Troubleshooting](./troubleshooting.md)**.
