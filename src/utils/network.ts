import { createServer } from "node:net";
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

function hasErrnoCode(e: unknown): e is { code: string } {
    return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string";
}

/**
 * Returns true if the given port is already bound on the given host.
 * Resolves false when the port is free (and closes the probe server).
 * Never throws for the normal EADDRINUSE case.
 */
export async function isPortInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();

        server.once("error", (err) => {
            if (hasErrnoCode(err) && err.code === "EADDRINUSE") {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        server.listen(port, host, () => {
            server.close(() => {
                resolve(false);
            });
        });
    });
}
