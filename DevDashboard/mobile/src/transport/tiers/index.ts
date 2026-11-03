import type { PairingPayload } from "@dd/contract";
import type { ProbeFailure } from "@/transport/reachability";
import { createCloudflaredTransport } from "@/transport/tiers/cloudflared";
import { createLanTransport } from "@/transport/tiers/lan";
import { createManagedTransport, pairManagedDevice } from "@/transport/tiers/managed";
import { createTailscaleTransport } from "@/transport/tiers/tailscale";
import type { Transport, TransportTier } from "@/transport/Transport";

/** Everything a tier builds a transport from: the saved row plus its secret, read from SecureStore. */
export interface TierTarget {
    label: string;
    baseUrl: string;
    host: string;
    port: number;
    username: string;
    /** The Basic-auth password; empty for a tier without one. */
    password: string;
    /** Fields only the managed tier has (the saved shape nests them the same way). */
    managed?: { agentPublicKey: string };
}

/** What a screen may ask of a connection; a tier that cannot serve one refuses it. */
export interface TierCapabilities {
    /**
     * The base URL may go to a WebView or the system browser as plain HTTP (the ttyd driver, a note's links, a share
     * URL). The managed tier refuses: its base URL is the vendor relay, which must only ever see sealed bytes (D9, D11).
     */
    plainUrls: boolean;
}

export interface TierDefinition {
    build(target: TierTarget): Promise<Transport>;
    /** The deadline of the tier's liveness probe. */
    probeTimeoutMs: number;
    /** What a failed probe means for the user on this tier. */
    probeFailure: ProbeFailure;
    /** What a first connect needs before its probe: nothing, or the one-time code the Mac shows. */
    pairing: "none" | "device-code";
    /** Registers the phone with the Mac before the first probe (`pairing`); the secret is the device code. */
    pair(target: TierTarget, secret: string): Promise<void>;
    capabilities: TierCapabilities;
}

/** A Basic-auth tier needs no registration: the password it sends with every request is the pairing. */
async function nothingToPair(): Promise<void> {}

/**
 * The tier table (M10): one row per way the phone reaches the Mac. A new tier (D10's managed domain) is one row, and
 * no call site compares tier names.
 */
export const TIERS: Record<TransportTier, TierDefinition> = {
    lan: {
        probeTimeoutMs: 2500,
        probeFailure: "unreachable",
        pairing: "none",
        pair: nothingToPair,
        capabilities: { plainUrls: true },
        build: async (target) =>
            createLanTransport(
                { name: target.label || target.host, host: target.host, port: target.port, baseUrl: target.baseUrl },
                { username: target.username, password: target.password },
                TIERS.lan.probeTimeoutMs
            ),
    },
    tailscale: {
        probeTimeoutMs: 3000,
        // The tailnet host does not resolve while the VPN is off, so a failed probe asks for Tailscale.
        probeFailure: "needs-vpn",
        pairing: "none",
        pair: nothingToPair,
        capabilities: { plainUrls: true },
        build: async (target) =>
            createTailscaleTransport(
                { tailnetHost: target.host, port: target.port, username: target.username, password: target.password },
                TIERS.tailscale.probeTimeoutMs
            ),
    },
    "cloudflared-self": {
        probeTimeoutMs: 4000,
        probeFailure: "unreachable",
        pairing: "none",
        pair: nothingToPair,
        capabilities: { plainUrls: true },
        build: async (target) => {
            const pairing: PairingPayload = {
                baseUrl: target.baseUrl,
                tier: "cloudflared-self",
                username: target.username,
            };
            return createCloudflaredTransport(pairing, target.password, TIERS["cloudflared-self"].probeTimeoutMs);
        },
    },
    managed: {
        probeTimeoutMs: 8000,
        probeFailure: "needs-pair",
        pairing: "device-code",
        pair: (target, deviceCode) =>
            pairManagedDevice({ baseUrl: target.baseUrl, deviceCode, agentPublicKey: target.managed?.agentPublicKey }),
        capabilities: { plainUrls: false },
        build: (target) =>
            createManagedTransport(
                {
                    baseUrl: target.baseUrl,
                    tier: "managed",
                    username: target.username,
                    agentPublicKey: target.managed?.agentPublicKey,
                },
                TIERS.managed.probeTimeoutMs
            ),
    },
};
