import { parsePairingPayload } from "@dd/contract";

import { useConnectionStore } from "@/state/connection-store";

export interface ApplyPairingResult {
    ok: boolean;
    error?: string;
}

/**
 * Parse a pairing URI/JSON and connect the matching transport, then probe reachability. Shared by
 * the QR-scan path (connect screen) and the deep-link path (pair route) so both stay in lockstep —
 * the only difference is where the payload string comes from. Reads the store via getState() so it
 * works outside React (e.g. a deep-link handler firing before the screen's own state settles).
 */
export async function applyPairingUri(uri: string, password = ""): Promise<ApplyPairingResult> {
    const pairing = parsePairingPayload(uri.trim());

    if (!pairing) {
        return { ok: false, error: "That is not a DevDashboard pairing code." };
    }

    try {
        console.log(`[connect] applyPairingUri tier=${pairing.tier} baseUrl=${pairing.baseUrl}`);
        const store = useConnectionStore.getState();

        if (pairing.tier === "managed") {
            await store.setManaged(pairing);
        } else {
            await store.setCloudflared(pairing, password);
        }

        const transport = useConnectionStore.getState().transport;
        const ok = transport ? await transport.reachable() : false;
        console.log(`[connect] applyPairingUri tier=${pairing.tier} reachable=${ok}`);

        return { ok };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
