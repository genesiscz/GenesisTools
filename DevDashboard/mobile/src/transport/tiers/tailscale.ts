import { makeBasicAuthHeader } from "@dd/contract";
import { fetch as expoFetch } from "expo/fetch";
import * as Linking from "expo-linking";
import { timeoutSignal } from "@/lib/abort-timeout";
import { createPlainTransport } from "@/transport/plain-transport";
import type { Transport } from "@/transport/Transport";

/** Tailscale's iOS/Android app store URL — opens the app if installed, else the store. */
const TAILSCALE_APP_URL = "https://apps.apple.com/app/tailscale/id1470499037";

export interface TailscaleConfig {
    /** e.g. "mac.tailnet-name.ts.net" or "100.x.y.z" — the user's tailnet host. */
    tailnetHost: string;
    port: number;
    username: string;
    password: string;
}

/** Opens Tailscale (or its store page). We CANNOT start the VPN programmatically on iOS (verified). */
export async function openTailscaleApp(): Promise<void> {
    await Linking.openURL(TAILSCALE_APP_URL);
}

export function createTailscaleTransport(config: TailscaleConfig): Transport {
    const baseUrl = `http://${config.tailnetHost}:${config.port}`;
    const authHeader = (): string => makeBasicAuthHeader({ username: config.username, password: config.password });

    return createPlainTransport({
        tier: "tailscale",
        baseUrl,
        authHeader,
        // When the VPN is down the tailnet host does not resolve/route -> probe fails ->
        // the reachability reducer maps a "tailscale" failure to needs-vpn.
        probe: async () => {
            const url = `${baseUrl}/api/system/pulse`;

            try {
                console.log(`[connect] probe tailscale -> ${url}`);
                const res = await expoFetch(url, {
                    method: "GET",
                    headers: { Authorization: authHeader() },
                    signal: timeoutSignal(3000),
                });
                console.log(`[connect] probe tailscale ${url} -> status ${res.status} (ok=${res.ok})`);
                return res.ok;
            } catch (err) {
                console.log(`[connect] probe tailscale ${url} FAILED: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
    });
}
