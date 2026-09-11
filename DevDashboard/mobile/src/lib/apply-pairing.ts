import { parsePairingPayload } from "@dd/contract";

import { useConnection } from "@/state/connection";
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

    const previousActiveId = useConnectionStore.getState().activeId;

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

        if (!ok) {
            await rollback(previousActiveId);
        }

        return { ok };
    } catch (err) {
        await rollback(previousActiveId);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * `setManaged` / `setCloudflared` persist the row, make it active and open the root layout's route
 * gate BEFORE anything is probed. Without this a failed pairing would leave the app navigated past
 * the connect screen onto an unreachable connection that survives a restart, while the screen said
 * "Pairing failed." Put the previous connection back, or close the gate when there is none.
 */
async function rollback(previousActiveId: string | null): Promise<void> {
    const store = useConnectionStore.getState();

    if (previousActiveId && previousActiveId !== store.activeId) {
        try {
            await store.activateConnection(previousActiveId);
            return;
        } catch (err) {
            console.warn("[connect] could not restore the previous connection after a failed pairing", err);
        }
    }

    useConnection.getState().reset();
}
