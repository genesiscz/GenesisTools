import type { PairingPayload } from "@dd/contract";
import { fromBase64, loadOrCreateDeviceKeys, naclBoxCipher } from "@/transport/e2e/box-cipher";
import { createE2eTransport } from "@/transport/e2e-transport";
import type { Transport } from "@/transport/Transport";

/** Builds the managed (vendor-relay) Transport. agentPublicKey came from the pairing QR (`pk`). */
export async function createManagedTransport(pairing: PairingPayload): Promise<Transport> {
    if (!pairing.agentPublicKey) {
        throw new Error("managed tier requires the Agent public key from the pairing QR");
    }

    const deviceKeys = await loadOrCreateDeviceKeys();

    return createE2eTransport({
        relayBaseUrl: pairing.baseUrl,
        cipher: naclBoxCipher,
        deviceKeys,
        agentPublicKey: fromBase64(pairing.agentPublicKey),
    });
}
