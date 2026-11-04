import type { WakeRelayDto } from "@app/dev-dashboard/contract/wake";
import { createWakeupStorage, DEFAULT_HTTP_PORT, readWakeupConfig, type WakeupConfig } from "@app/wakeup/config";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

/**
 * The wakeup relay this Mac is registered with, for the phone's Wake my Mac button (F26). The phone stores it,
 * because a sleeping Mac cannot hand it out. Read only.
 */

const LOOPBACK = /^(localhost|127\.|::1$|\[::1\])/;

function relayUrl(host: string, port: number): string {
    if (/^https?:\/\//.test(host)) {
        const url = new URL(host);
        url.port = String(port);
        return url.origin;
    }

    return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export function wakeRelayOf(config: WakeupConfig): WakeRelayDto {
    const host = config.client?.serverHost ?? config.server?.host ?? null;
    const port = config.client?.serverPort ?? config.server?.port ?? DEFAULT_HTTP_PORT;
    const name = config.client?.name ?? null;
    const password = config.client?.password ?? null;
    const token = config.server?.token ?? null;

    if (!host || !name || !password) {
        return {
            configured: false,
            url: host ? relayUrl(host, port) : null,
            name,
            password: null,
            token: null,
            note: `No relay login on this Mac yet: run ${toolCommand("wakeup login")} against the always-on relay`,
        };
    }

    return {
        configured: true,
        url: relayUrl(host, port),
        name,
        password,
        token,
        note: LOOPBACK.test(host)
            ? "The relay runs on this Mac, so it sleeps with it: run the relay on an always-on machine on the same LAN"
            : null,
    };
}

export async function wakeRelay(storage = createWakeupStorage()): Promise<WakeRelayDto> {
    return wakeRelayOf(await readWakeupConfig(storage));
}
