import { fetch as expoFetch } from "expo/fetch";
import { timeoutSignal } from "@/lib/abort-timeout";
import type { TransportTier } from "@/transport/Transport";

/**
 * The one liveness probe of the plain tiers: an authenticated GET of `/api/system/pulse` with the tier's own
 * deadline (`TIERS[tier].probeTimeoutMs`). It was written three times (LAN, Tailscale, cloudflared) with three
 * deadlines and three copied log lines; a health route is now one edit here.
 */
export async function probePulse({
    tier,
    baseUrl,
    authHeader,
    timeoutMs,
}: {
    tier: TransportTier;
    baseUrl: string;
    authHeader: () => string | undefined;
    timeoutMs: number;
}): Promise<boolean> {
    const url = `${baseUrl}/api/system/pulse`;
    const auth = authHeader();

    try {
        console.log(`[connect] probe ${tier} -> ${url}`);
        const res = await expoFetch(url, {
            method: "GET",
            headers: auth ? { Authorization: auth } : {},
            signal: timeoutSignal(timeoutMs),
        });
        console.log(`[connect] probe ${tier} ${url} -> status ${res.status} (ok=${res.ok})`);
        return res.ok;
    } catch (err) {
        console.log(`[connect] probe ${tier} ${url} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
