import { makeBasicAuthHeader } from "@dd/contract";
import { fetch as expoFetch } from "expo/fetch";
import { timeoutSignal } from "@/lib/abort-timeout";
import { createPlainTransport } from "@/transport/plain-transport";
import type { DiscoveredAgent } from "@/transport/lan-discovery";
import type { Transport } from "@/transport/Transport";

export interface LanCredentials {
    username: string;
    password: string;
}

export function createLanTransport(agent: DiscoveredAgent, creds: LanCredentials): Transport {
    const authHeader = (): string => makeBasicAuthHeader(creds);

    return createPlainTransport({
        tier: "lan",
        baseUrl: agent.baseUrl,
        authHeader,
        probe: async () => {
            const url = `${agent.baseUrl}/api/system/pulse`;

            try {
                console.log(`[connect] probe lan -> ${url}`);
                const res = await expoFetch(url, {
                    method: "GET",
                    headers: { Authorization: authHeader() },
                    signal: timeoutSignal(2500),
                });
                console.log(`[connect] probe lan ${url} -> status ${res.status} (ok=${res.ok})`);
                return res.ok;
            } catch (err) {
                console.log(`[connect] probe lan ${url} FAILED: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
    });
}
