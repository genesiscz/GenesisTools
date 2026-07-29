# Getting Started

Put your dev machine in your pocket — live terminals, system Pulse, and agent-session alerts on
your phone, over a transport you can verify. This guide takes you from zero to a live, private
connection in about ten minutes.

> **The promise, up front:** *Your machine. Your keys. We can't see your data — and you can prove
> it.* You never pay for privacy; it's the floor on every tier. See
> [Security & Trust](./security-and-trust.md) for exactly why that's true and how to verify it.

---

## What you'll need

- A **Mac** running the things you want to watch (tmux/cmux sessions, builds, agents).
- The **DevDashboard mobile app** on your phone (iOS first).
- About **10 minutes**. No domain, no cloud account, and no credit card are required to start —
  the Free tier is fully self-hosted.

---

## The path

The dashboard's **Overview** page tracks your progress as a 4-step checklist. This guide follows it,
plus the two steps that happen on your devices:

1. [Sign up](#1-sign-up) *(only needed for managed remote — skip for self-host)*
2. [Choose a plan](#2-choose-a-plan)
3. [Claim a managed subdomain](#3-claim-a-managed-subdomain) *(optional)*
4. [Install the agent on your Mac](#4-install-the-agent)
5. [Pair your phone](#5-pair-your-phone)
6. [Verify safety numbers](#6-verify-safety-numbers)
7. [You're live](#7-youre-live)

> **Self-hosting? You can skip steps 1–3.** LAN, Tailscale, and your own Cloudflare tunnel need no
> account at all — jump to [Install the agent](#4-install-the-agent) and pair over your own pipe.
> The cloud account only buys *managed remote + push alerts* (see [Pricing & Tiers](./pricing-and-tiers.md)).

---

## 1. Sign up

Go to the cloud app and create an account with your email and a password
(`/signup`). Verification is not required to start, and you're signed in automatically.

If you arrived from a pricing CTA, the plan is pre-selected — e.g. `/signup?plan=pro` shows
"Start your pro plan". You can change it later from the [Billing](#2-choose-a-plan) page.

Once signed in you land on **`/dashboard`** — the Overview, with your plan, paired-device count,
and managed-subdomain status, plus the "Get remote in 4 steps" checklist. *Account created* is
already ticked.

## 2. Choose a plan

From the Overview, follow **Manage plan** (or go to `/dashboard/billing`).

- **Free** — self-host forever. LAN + Tailscale + your own Cloudflare tunnel, full feature set,
  1 device. Nothing to buy. *Choose this if you're happy bringing your own pipe.*
- **Pro** — adds one-tap **managed remote** (with end-to-end encryption), push alerts, a managed
  subdomain, and unlimited devices.
- **Team** — adds shared machines, role-based access, on-call routing, audit log, and SSO.

A full breakdown — and what each tier can and can't see — is in
[Pricing & Tiers](./pricing-and-tiers.md).

> Picking Pro/Team ticks the second checklist item. On Free you simply skip it.

## 3. Claim a managed subdomain

*Optional — for managed remote when you don't own a domain.*

Open the **Setup wizard** (`/dashboard/setup`) and use **Claim your managed subdomain**. Enter a
name (3–32 lowercase letters, digits, or hyphens) and submit. You'll get
`your-name.devdashboard.app`, which your agent's tunnel will route to.

The hostname appears on your Overview under **Managed subdomain**, ticking the third checklist item.

> If the operator hasn't configured Cloudflare yet, the wizard shows a **demo-mode** note — the
> subdomain is reserved on your account but not yet live on the edge. That's expected on a fresh
> deployment; see [Troubleshooting](./troubleshooting.md#subdomain-stuck-in-demo-mode).

## 4. Install the agent

This is where your machine actually starts streaming. One command on your Mac:

```bash
devdash agent start
```

The agent serves your terminals and Pulse **locally** — nothing leaves the machine yet. Then you
pick a transport (LAN, Tailscale, your own tunnel, or managed) and it hands you a pairing QR.

The full walkthrough — every transport, what data does and doesn't leave the machine, and the
pairing flow — is in **[Install the Agent](./install-the-agent.md)**.

## 5. Pair your phone

Open the mobile app and **scan the QR** shown by your Mac agent. The phone and Mac generate their
own pairing keys on-device; the pairing secret never passes through the cloud.

Pairing your Mac agent + phone ticks the fourth and final checklist item. Your devices then appear
under [`/dashboard/devices`](./troubleshooting.md) (the cloud records each device's **public key
only**).

## 6. Verify safety numbers

On a managed connection, the app shows a **safety number** (a key fingerprint) on both your phone
and your Mac. Compare them — just like verifying a contact in an end-to-end-encrypted chat. If they
match, you have a confirmed end-to-end channel and the relay is carrying only ciphertext.

This is the "and you can prove it" part of the promise. Don't skip it the first time you pair over
managed remote. Details in [Security & Trust](./security-and-trust.md#verify-it-yourself).

## 7. You're live

You now have your machine in your pocket:

- **Terminals** — live tmux/cmux panes, interactive.
- **Pulse** — CPU, memory, swap, battery, disk, Wi-Fi, with sparklines.
- **QA / agent stream** — the live event feed from your sessions.
- **Push alerts** *(Pro)* — get pinged the moment an agent is waiting on you or a build breaks.

Manage push-alert preferences under [`/dashboard/settings`](./troubleshooting.md), add or remove
devices under `/dashboard/devices`, and switch transports any time from the mobile app.

---

## Next steps

- **[Install the Agent](./install-the-agent.md)** — transports, pairing, and the data boundary in detail.
- **[Pricing & Tiers](./pricing-and-tiers.md)** — when to pay, and for what (never privacy).
- **[Security & Trust](./security-and-trust.md)** — the full no-see story and how to verify it.
- **Stuck?** → **[Troubleshooting](./troubleshooting.md)**.
