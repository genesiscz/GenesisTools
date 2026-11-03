import { makeBasicAuthHeader } from "@dd/contract";
import { createPlainTransport } from "@/transport/plain-transport";
import { probePulse } from "@/transport/probe";
import type { DiscoveredAgent } from "@/transport/lan-discovery";
import type { Transport } from "@/transport/Transport";

export interface LanCredentials {
    username: string;
    password: string;
}

export function createLanTransport(agent: DiscoveredAgent, creds: LanCredentials, probeTimeoutMs = 2500): Transport {
    const authHeader = (): string => makeBasicAuthHeader(creds);

    return createPlainTransport({
        tier: "lan",
        baseUrl: agent.baseUrl,
        authHeader,
        probe: () => probePulse({ tier: "lan", baseUrl: agent.baseUrl, authHeader, timeoutMs: probeTimeoutMs }),
    });
}
