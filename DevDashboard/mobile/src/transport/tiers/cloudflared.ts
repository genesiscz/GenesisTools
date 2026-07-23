import { makeBasicAuthHeader, type PairingPayload } from "@dd/contract";
import { fetch as expoFetch } from "expo/fetch";
import { timeoutSignal } from "@/lib/abort-timeout";
import { createPlainTransport } from "@/transport/plain-transport";
import type { Transport } from "@/transport/Transport";

export function createCloudflaredTransport(pairing: PairingPayload, password: string): Transport {
    const authHeader = (): string => makeBasicAuthHeader({ username: pairing.username, password });

    return createPlainTransport({
        tier: "cloudflared-self",
        baseUrl: pairing.baseUrl,
        authHeader,
        probe: async () => {
            const url = `${pairing.baseUrl}/api/system/pulse`;

            try {
                console.log(`[connect] probe cloudflared-self -> ${url}`);
                const res = await expoFetch(url, {
                    method: "GET",
                    headers: { Authorization: authHeader() },
                    signal: timeoutSignal(4000),
                });
                console.log(`[connect] probe cloudflared-self ${url} -> status ${res.status} (ok=${res.ok})`);
                return res.ok;
            } catch (err) {
                console.log(`[connect] probe cloudflared-self ${url} FAILED: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
    });
}
