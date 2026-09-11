import { parsePairingPayload, type PairingPayload } from "@dd/contract";

/** Wraps the (RN-safe, contract-hosted) pairing parser; rejects anything that isn't a pairing URI. */
export function parseScannedPairing(scanned: string): PairingPayload | null {
    return parsePairingPayload(scanned.trim());
}
