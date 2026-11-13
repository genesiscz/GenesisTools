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

/** The deadline of the password check after a failed pairing; the slowest tier's probe deadline. */
const PASSWORD_CHECK_MS = 4000;

/**
 * Whether the dashboard at `baseUrl` asks for a password: its pulse answers 401 to a request without one. A pairing
 * that failed for another reason (no answer, a timeout, a refused link) must not ask for a secret that cannot help.
 */
export async function asksForPassword(baseUrl: string, timeoutMs: number = PASSWORD_CHECK_MS): Promise<boolean> {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/system/pulse`;

    try {
        const res = await expoFetch(url, { method: "GET", signal: timeoutSignal(timeoutMs) });
        return res.status === 401;
    } catch (err) {
        console.log(`[connect] password check ${url} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
