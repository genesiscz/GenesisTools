import { parsePairingPayload } from "@dd/contract";

import { type ConnectResult, useConnectionStore } from "@/state/connection-store";
import { FAILURE_MESSAGE } from "@/transport/reachability";

export interface ApplyPairingResult {
    ok: boolean;
    error?: string;
}

/** The secrets a pairing asks the user for; the QR and the deep link never carry them. */
export interface PairingSecrets {
    /** The tunnel's Basic-auth password (cloudflared-self). */
    password?: string;
    /** The one-time code the Mac shows (managed). */
    deviceCode?: string;
}

function messageOf(result: ConnectResult): string | undefined {
    return result.ok ? undefined : (result.error ?? FAILURE_MESSAGE[result.failure]);
}

/**
 * Parse a pairing URI/JSON and connect through the connection session (`connect`: build, pair when the tier asks,
 * probe, then commit). Shared by the QR-scan path (connect screen) and the deep-link path (pair route). A failed
 * probe commits nothing, so there is nothing to roll back.
 */
export async function applyPairingUri(uri: string, secrets: PairingSecrets = {}): Promise<ApplyPairingResult> {
    const pairing = parsePairingPayload(uri.trim());

    if (!pairing) {
        return { ok: false, error: "That is not a DevDashboard pairing code." };
    }

    const base = pairing.baseUrl.replace(/\/+$/, "");
    const url = new URL(base);
    const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
    console.log(`[connect] applyPairingUri tier=${pairing.tier} baseUrl=${base}`);
    const result = await useConnectionStore.getState().connect({
        tier: pairing.tier,
        baseUrl: base,
        host: url.hostname,
        port,
        username: pairing.username ?? "",
        password: secrets.password ?? "",
        ...(secrets.deviceCode ? { deviceCode: secrets.deviceCode } : {}),
        ...(pairing.agentPublicKey ? { tierOptions: { managed: { agentPublicKey: pairing.agentPublicKey } } } : {}),
    });
    console.log(`[connect] applyPairingUri tier=${pairing.tier} ok=${result.ok}`);

    return { ok: result.ok, error: messageOf(result) };
}
