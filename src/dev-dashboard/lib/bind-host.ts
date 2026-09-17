import type { DashboardBindHost } from "@genesiscz/utils/DashboardApp";
import { env } from "@genesiscz/utils/env";

/**
 * dev-dashboard is the one dashboard that listens on every interface by default: it is reached
 * through cloudflared and from phones on the LAN. The DashboardApp launcher still wins through
 * DASHBOARD_BIND_HOST, so `bindHost` in the per-dashboard preferences file can pin it to loopback.
 */
export function resolveDevDashboardBindHost(): DashboardBindHost {
    return env.dashboard.getBindHost("0.0.0.0") === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
}
