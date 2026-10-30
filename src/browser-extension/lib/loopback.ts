import type { PlainNavigationService } from "./host/messages";

/**
 * A typed loopback address (`http://localhost:<port>`, `http://127.0.0.1:<port>`) of a registered server.
 * Shared by the host and the extension bundle, so it imports nothing at runtime.
 */

/** The two spellings the extension catches. `[::1]` and every other loopback address stay a normal navigation. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;

/**
 * The port of a loopback URL written out literally, else null. Only `http:` (these servers do not speak TLS),
 * only the host `localhost` or `127.0.0.1` with an explicit port, and no userinfo. A trailing dot, a suffix host,
 * `127.0.0.2`, `0.0.0.0` and `[::1]` are refused. The URL parser turns `2130706433`, `0x7f.1` and `127.1` into
 * `127.0.0.1`, so the raw text must start with the parsed authority as well: the check fails closed instead of
 * trusting a normalization.
 */
export function loopbackPort(value: unknown): number | null {
    if (typeof value !== "string" || value.length > 4000 || !URL.canParse(value)) {
        return null;
    }

    const url = new URL(value);

    if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.port === "") {
        return null;
    }

    if (!(LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)) {
        return null;
    }

    const authority = `http://${url.hostname}:${url.port}`;

    if (!value.startsWith(authority) || !/^(?:[/?#]|$)/.test(value.slice(authority.length))) {
        return null;
    }

    return Number(url.port);
}

/** The host permissions a build grants for one port: these two origins, never a port wildcard. */
export function loopbackOrigins(port: number): string[] {
    return LOOPBACK_HOSTS.map((host) => `http://${host}:${port}/*`);
}

/** The redirect rule's regex for these ports; the host and port are spelled out, so a suffix host never matches. */
export function loopbackRegex(ports: readonly number[]): string {
    return `^http://(?:localhost|127\\.0\\.0\\.1):(?:${ports.join("|")})/.*$`;
}

/** Whether the downloaded config lets a plain browser navigation start the server on `port`. */
export function allowsPlainNavigation(services: readonly PlainNavigationService[], port: number): boolean {
    return services.some(
        (service) => service.port === port && service.allowExecuteByPlainBrowserNavigationMightBeDangerous === true
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `router.services` reply as the extension reads it: an entry that does not parse is dropped, never trusted. */
export function readPlainNavigationServices(data: unknown): PlainNavigationService[] {
    const list = isRecord(data) && Array.isArray(data.services) ? data.services : [];
    return list.flatMap((item): PlainNavigationService[] => {
        if (
            !isRecord(item) ||
            typeof item.port !== "number" ||
            !Number.isInteger(item.port) ||
            item.port < 1 ||
            item.port > 65_535 ||
            typeof item.name !== "string" ||
            typeof item.target !== "string"
        ) {
            return [];
        }

        return [
            {
                port: item.port,
                name: item.name,
                allowExecuteByPlainBrowserNavigationMightBeDangerous:
                    item.allowExecuteByPlainBrowserNavigationMightBeDangerous === true,
                target: item.target,
            },
        ];
    });
}
