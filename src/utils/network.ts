import { networkInterfaces } from "node:os";

/**
 * Returns the first non-internal IPv4 address (LAN IP).
 * Falls back to 127.0.0.1 when no external interface is found.
 */
export function getLocalIpv4(): string {
    for (const ifaces of Object.values(networkInterfaces())) {
        for (const iface of ifaces ?? []) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }

    return "127.0.0.1";
}
