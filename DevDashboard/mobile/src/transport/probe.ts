import { fetch as expoFetch } from "expo/fetch";
import { timeoutSignal } from "@/lib/abort-timeout";
import type { TransportTier } from "@/transport/Transport";

/** The dashboard's health route at `baseUrl`; both checks below read it, so a route change is one edit. */
function pulseUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/api/system/pulse`;
}

/** One GET of the pulse with a deadline. Null when it throws (no answer, a timeout, a refused link), logged as `label`. */
async function fetchPulse(
    url: string,
    { label, headers, timeoutMs }: { label: string; headers?: Record<string, string>; timeoutMs: number }
) {
    try {
        return await expoFetch(url, { method: "GET", headers: headers ?? {}, signal: timeoutSignal(timeoutMs) });
    } catch (err) {
        console.log(`[connect] ${label} ${url} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

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
    const url = pulseUrl(baseUrl);
    const auth = authHeader();
    console.log(`[connect] probe ${tier} -> ${url}`);
    const res = await fetchPulse(url, { label: `probe ${tier}`, headers: auth ? { Authorization: auth } : {}, timeoutMs });

    if (!res) {
        return false;
    }

    console.log(`[connect] probe ${tier} ${url} -> status ${res.status} (ok=${res.ok})`);
    return res.ok;
}

/** The deadline of the password check after a failed pairing; the slowest tier's probe deadline. */
const PASSWORD_CHECK_MS = 4000;

/**
 * Whether the dashboard at `baseUrl` asks for a password: its pulse answers 401 to a request without one. A pairing
 * that failed for another reason (no answer, a timeout, a refused link) must not ask for a secret that cannot help.
 */
export async function asksForPassword(baseUrl: string, timeoutMs: number = PASSWORD_CHECK_MS): Promise<boolean> {
    const res = await fetchPulse(pulseUrl(baseUrl), { label: "password check", timeoutMs });
    return res?.status === 401;
}
