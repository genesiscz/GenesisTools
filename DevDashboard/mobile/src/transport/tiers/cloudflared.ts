import { makeBasicAuthHeader, type PairingPayload } from "@dd/contract";
import { createPlainTransport } from "@/transport/plain-transport";
import { probePulse } from "@/transport/probe";
import type { Transport } from "@/transport/Transport";

export function createCloudflaredTransport(pairing: PairingPayload, password: string, probeTimeoutMs = 4000): Transport {
    const authHeader = (): string => makeBasicAuthHeader({ username: pairing.username, password });

    return createPlainTransport({
        tier: "cloudflared-self",
        baseUrl: pairing.baseUrl,
        authHeader,
        probe: () =>
            probePulse({ tier: "cloudflared-self", baseUrl: pairing.baseUrl, authHeader, timeoutMs: probeTimeoutMs }),
    });
}
