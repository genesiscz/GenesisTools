/**
 * The SINGLE source of truth for the four trust tiers and their exact, architecture-honest
 * trust claims. Every trust string the landing page renders is derived from here, and the
 * parity test (`tier-policy.test.ts`) asserts the claim semantics match DECISIONS.md (D11) /
 * ADR §4 verbatim. This satisfies "marketing must match architecture" and makes the landing
 * copy testable.
 *
 * Tiers + claim semantics (D11):
 * - LAN: unconditional no-see (no relay, no edge, no vendor in the path).
 * - Tailscale/WireGuard: unconditional no-see (relays carry ciphertext only, by construction).
 * - self-hosted cloudflared: "the vendor can't see your data" — the tunnel runs on the USER'S
 *   OWN Cloudflare account (with the CF-terminates-TLS-at-its-edge caveat).
 * - managed: no-see ONLY as a PROPERTY OF THE E2E LAYER, plus a metadata (timing/sizes/
 *   endpoints) caveat. Never claims "unconditional".
 */

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
    /** Short badge shown on the tier card ("Zero third party", "Trust-max", …). */
    readonly badge: string;
    /** The short "no-see" line rendered as the card's footer promise. */
    readonly noSeeLine: string;
}

export const TIER_POLICY: readonly TrustTier[] = [
    {
        id: "lan",
        label: "Local network",
        tagline: "Same Wi-Fi, zero third parties.",
        claim: "Nothing leaves your network. We cannot see your data — there is no relay, no edge, no vendor in the path.",
        noSee: "unconditional",
        setup: "Auto-discovers your Mac on the same Wi-Fi. No account, no setup.",
        badge: "Zero third party",
        noSeeLine: "We can't see your data",
    },
    {
        id: "tailscale",
        label: "Tailscale / WireGuard",
        tagline: "Remote access, end-to-end encrypted.",
        claim: "Your phone and Mac speak WireGuard end-to-end. Relays see only ciphertext — we cannot see your data, by construction.",
        noSee: "unconditional",
        setup: "Install the Tailscale app and sign in. We detect your tailnet and connect — we never touch your keys.",
        badge: "Trust-max",
        noSeeLine: "We can't see your data",
    },
    {
        id: "cloudflared-self",
        label: "Self-hosted tunnel",
        tagline: "One-command tunnel on your own account.",
        claim: "The tunnel runs on your own Cloudflare account, not ours — so the vendor can't see your data. (Cloudflare terminates TLS at its edge, as with any Cloudflare tunnel.)",
        noSee: "unconditional",
        setup: "Run `tools dev-dashboard tunnel setup`: it installs cloudflared, walks the login, and prints a pairing QR. No copy-paste.",
        badge: "Self-hosted · guided wizard",
        noSeeLine: "Vendor never in the path",
    },
    {
        id: "managed",
        label: "Managed (one-tap)",
        tagline: "We set everything up. Keys stay on your devices.",
        claim: "One tap, no setup. Because our relay terminates the transport, your data stays private only through end-to-end encryption above it: keys are generated on your phone and Mac and never leave them — the vendor never escrows them. The relay forwards opaque ciphertext.",
        noSee: "e2e-conditional",
        caveat: "The relay still sees connection metadata (timing, sizes, endpoints) — not your data.",
        setup: "Sign up, scan one QR shown by your Mac agent. We provision the relay; the pairing secret never passes through us.",
        badge: "One-tap · app-layer E2E",
        noSeeLine: "No-see via E2E",
    },
] as const;

export function tierById(id: TrustTierId): TrustTier {
    const found = TIER_POLICY.find((t) => t.id === id);

    if (!found) {
        throw new Error(`unknown trust tier: ${id}`);
    }

    return found;
}
