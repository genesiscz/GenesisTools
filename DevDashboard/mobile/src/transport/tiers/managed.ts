import type { PairingPayload } from "@dd/contract";
import { fetch as expoFetch } from "expo/fetch";
import { timeoutSignal } from "@/lib/abort-timeout";
import { fromBase64, loadOrCreateDeviceKeys, naclBoxCipher, toBase64 } from "@/transport/e2e/box-cipher";
import { createE2eTransport } from "@/transport/e2e-transport";
import type { Transport } from "@/transport/Transport";

/**
 * Builds the managed (vendor-relay) Transport. agentPublicKey came from the pairing QR (`pk`). `probeTimeoutMs`
 * bounds the liveness probe, so a relay that never answers fails the probe instead of hanging the connect.
 */
export async function createManagedTransport(pairing: PairingPayload, probeTimeoutMs?: number): Promise<Transport> {
    if (!pairing.agentPublicKey) {
        throw new Error("managed tier requires the Agent public key from the pairing QR");
    }

    const deviceKeys = await loadOrCreateDeviceKeys();

    return createE2eTransport({
        relayBaseUrl: pairing.baseUrl,
        cipher: naclBoxCipher,
        deviceKeys,
        agentPublicKey: fromBase64(pairing.agentPublicKey),
        ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
    });
}

/**
 * Registers this phone's PUBLIC key with the Mac through the existing E2E pair route (`POST /api/e2e/pair`), with
 * the one-time device code the Mac shows. The Mac admits only a device that presents that code, so the relay cannot
 * pair itself. Sealed traffic works only after this; a later launch needs no second pair (the Mac keeps the key).
 */
export async function pairManagedDevice({ baseUrl, deviceCode }: { baseUrl: string; deviceCode: string }): Promise<void> {
    const code = deviceCode.trim();

    if (!code) {
        throw new Error("Type the pairing code your Mac shows.");
    }

    const keys = await loadOrCreateDeviceKeys();
    const res = await expoFetch(`${baseUrl.replace(/\/+$/, "")}/api/e2e/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: toBase64(keys.publicKey), deviceCode: code }),
        signal: timeoutSignal(8000),
    });

    if (res.status === 403) {
        throw new Error("The Mac refused the pairing code: it is wrong or expired. Ask the Mac for a new one.");
    }

    if (!res.ok) {
        throw new Error(`The Mac could not pair this phone (HTTP ${res.status}).`);
    }
}
