// Pairing payload codec — the SOURCE OF TRUTH for the `devdashboard://pair?…` URI
// embedded in the QR code. Pure `URLSearchParams` only (no disk, no node:/bun:), so
// both the Agent wizard (`lib/tunnel/pairing.ts` re-exports + adds disk persistence)
// and the mobile QR scanner (`src/lib/qr.ts`) decode the exact same wire shape.

export type PairingTier = "cloudflared-self" | "managed";

export interface PairingPayload {
    tier: PairingTier;
    baseUrl: string;
    username: string;
    /** Managed tier only: the Agent's X25519 public key (base64) for E2E pairing (Task 9/10). */
    agentPublicKey?: string;
}

const SCHEME = "devdashboard://pair?";

/** Encode the pairing payload as a `devdashboard://pair?…` URI (QR-friendly, compact). */
export function buildPairingPayload(payload: PairingPayload): string {
    const sp = new URLSearchParams();
    sp.set("tier", payload.tier);
    sp.set("baseUrl", payload.baseUrl);
    sp.set("username", payload.username);

    if (payload.agentPublicKey) {
        sp.set("pk", payload.agentPublicKey);
    }

    return `${SCHEME}${sp.toString()}`;
}

/** Decode a scanned pairing URI, or null if it is not a valid `devdashboard://pair` payload. */
export function parsePairingPayload(uri: string): PairingPayload | null {
    if (!uri.startsWith(SCHEME)) {
        return null;
    }

    const sp = new URLSearchParams(uri.slice(SCHEME.length));
    const tier = sp.get("tier");
    const baseUrl = sp.get("baseUrl");
    const username = sp.get("username");

    if ((tier !== "cloudflared-self" && tier !== "managed") || !baseUrl || !username) {
        return null;
    }

    const payload: PairingPayload = { tier, baseUrl, username };
    const pk = sp.get("pk");

    if (pk) {
        payload.agentPublicKey = pk;
    }

    return payload;
}
