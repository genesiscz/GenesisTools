import { encodeE2ePairAdmission, encodeEnvelope, type PairingPayload } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
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
 * The pair request body: the one-time code sealed to the Mac's QR-pinned key with this phone's secret key, so the
 * relay (which terminates TLS) can neither read the code nor bind it to a key of its own.
 */
export function sealPairAdmission({
    deviceCode,
    agentPublicKey,
    deviceKeys,
}: {
    deviceCode: string;
    agentPublicKey: Uint8Array;
    deviceKeys: { publicKey: Uint8Array; secretKey: Uint8Array };
}): string {
    const nonce = naclBoxCipher.randomNonce();
    const ct = naclBoxCipher.seal({
        plaintext: new TextEncoder().encode(encodeE2ePairAdmission({ deviceCode })),
        nonce,
        recipientPublicKey: agentPublicKey,
        senderSecretKey: deviceKeys.secretKey,
    });
    const envelope = encodeEnvelope({ v: 1, epk: toBase64(deviceKeys.publicKey), n: toBase64(nonce), ct: toBase64(ct) });

    return SafeJSON.stringify({ envelope }, { strict: true });
}

/**
 * Registers this phone's PUBLIC key with the Mac through the existing E2E pair route (`POST /api/e2e/pair`), with
 * the one-time device code the Mac shows, sealed to the Mac's key from the pairing QR. The Mac admits only a device
 * that presents that code, so the relay cannot pair itself. Sealed traffic works only after this; a later launch
 * needs no second pair (the Mac keeps the key).
 */
export async function pairManagedDevice({
    baseUrl,
    deviceCode,
    agentPublicKey,
}: {
    baseUrl: string;
    deviceCode: string;
    agentPublicKey: string | undefined;
}): Promise<void> {
    const code = deviceCode.trim().toUpperCase();

    if (!code) {
        throw new Error("Type the pairing code your Mac shows.");
    }

    if (!agentPublicKey) {
        throw new Error("managed tier requires the Agent public key from the pairing QR");
    }

    const keys = await loadOrCreateDeviceKeys();
    const res = await expoFetch(`${baseUrl.replace(/\/+$/, "")}/api/e2e/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: sealPairAdmission({ deviceCode: code, agentPublicKey: fromBase64(agentPublicKey), deviceKeys: keys }),
        signal: timeoutSignal(8000),
    });

    if (res.status === 403) {
        throw new Error("The Mac refused the pairing code: it is wrong or expired. Ask the Mac for a new one.");
    }

    if (!res.ok) {
        throw new Error(`The Mac could not pair this phone (HTTP ${res.status}).`);
    }
}
