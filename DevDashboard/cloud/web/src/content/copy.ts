/**
 * All landing-page section copy. Trust strings are DERIVED from the shared tier-policy
 * (the single source of truth) so the marketing can never drift from the architecture (D11).
 */

import { TIER_POLICY, type TrustTier } from "@shared/tier-policy";

export interface PricingPlan {
    name: string;
    subtitle: string;
    price: string;
    cadence: string;
    features: string[];
    cta: string;
    featured?: boolean;
    /** Maps to the dashboard signup flow / Stripe price tier. */
    tier: "free" | "pro" | "team";
}

export const NAV_LINKS = [
    { href: "#trust", label: "Trust" },
    { href: "#features", label: "Features" },
    { href: "#how", label: "How it works" },
    { href: "#pricing", label: "Pricing" },
] as const;

export const HERO = {
    eyebrow: "Privacy-first dev telemetry",
    titlePre: "Your machine, ",
    titleGrad: "streamed to your phone",
    titlePost: " — and we can't see your data.",
    body: "Live tmux & cmux terminals, real-time system Pulse, and agent-session alerts — right in your pocket. Behind one switchable transport you can verify yourself: LAN, Tailscale, your own Cloudflare tunnel, or managed with end-to-end encryption.",
    primaryCta: "Pair in ~30 seconds",
    secondaryCta: "See how to verify it",
} as const;

export const TRUST_SECTION = {
    eyebrow: "The differentiator",
    titlePre: "Trust you can ",
    titleGrad: "verify",
    titlePost: ", not just take our word for.",
    body: "One switchable transport layer. You choose how your phone reaches your Mac — and at every tier, the privacy promise is a property of the architecture, not a marketing line.",
    promiseTitle: "“Your machine. Your keys. We can't see your data — and you can prove it.”",
    promiseBody:
        "Pairing keys are generated on-device and never escrowed. The protocol is open and the clients are auditable, so you don't have to trust the marketing — you can read the code, inspect the handshake, and confirm the relay only ever carries ciphertext.",
    promiseBullets: [
        "X25519 ECDH pairing → per-message AEAD",
        "Keys in your phone's secure enclave + your Mac only",
        "Safety-number check, like a verified chat",
    ],
} as const;

export const FEATURES_SECTION = {
    eyebrow: "Built for agent operators",
    titlePre: "Monitor and ",
    titleGrad: "steer",
    titlePost: " from anywhere.",
    body: "Everything you watch on your desk, on the device that's always in your hand.",
} as const;

export const HOW_SECTION = {
    eyebrow: "Pair in ~30 seconds",
    titlePre: "Three steps. ",
    titleGrad: "No cloud account required.",
    steps: [
        {
            n: "01",
            title: "Run the agent on your Mac",
            body: "One command starts the DevDashboard Agent. It serves your terminals and Pulse locally — nothing leaves the machine yet.",
            code: "devdash agent start",
        },
        {
            n: "02",
            title: "Pick your transport",
            body: "LAN, Tailscale, your own Cloudflare tunnel, or managed. The wizard sets up the path you choose and hands you a pairing QR.",
        },
        {
            n: "03",
            title: "Scan & verify on your phone",
            body: "Scan the QR, compare safety numbers, and you're live. Keys stay on your two devices — confirm the channel is end-to-end and you're done.",
        },
    ],
} as const;

export const PRICING_SECTION = {
    eyebrow: "Pricing",
    titlePre: "Self-host free, forever. ",
    titleGrad: "Pay only for convenience.",
    body: "Every paid tier is convenience on top — never the price of privacy.",
} as const;

export const PRICING_PLANS: readonly PricingPlan[] = [
    {
        name: "Free",
        subtitle: "Self-host",
        price: "$0",
        cadence: "forever",
        tier: "free",
        features: [
            "Terminals, Pulse, QA, Obsidian",
            "LAN + Tailscale transports",
            "Your own Cloudflare tunnel wizard",
            "1 device",
        ],
        cta: "Get the agent",
    },
    {
        name: "Pro",
        subtitle: "Managed remote + E2E",
        price: "$8",
        cadence: "/mo · billed yearly",
        tier: "pro",
        featured: true,
        features: [
            "Everything in Free",
            "One-tap managed remote, app-layer E2E",
            "Managed sub-domain (no domain needed)",
            "Push alerts + unlimited devices",
        ],
        cta: "Start Pro",
    },
    {
        name: "Team",
        subtitle: "For on-call & agencies",
        price: "$24",
        cadence: "/mo · per seat",
        tier: "team",
        features: [
            "Everything in Pro",
            "Shared machines + role-based access",
            "On-call routing + audit log",
            "SSO + priority support",
        ],
        cta: "Talk to us",
    },
] as const;

export const FOOTER = {
    eyebrow: "Ship with confidence",
    title: "Put your dev machine in your pocket.",
    body: "Your machine. Your keys. We can't see your data — and you can prove it.",
    cta: "Get early access",
    finePrint: "No credit card · self-host stays free",
    links: ["Trust", "Features", "Pricing", "Open protocol", "Security"],
} as const;

/** The four trust tiers, in display order, straight from the policy. */
export const TRUST_TIERS: readonly TrustTier[] = TIER_POLICY;
