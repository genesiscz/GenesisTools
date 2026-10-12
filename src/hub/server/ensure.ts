import { stat } from "node:fs/promises";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { askHubServer, type HubServerProbe } from "./client";

/** A server that dies at start must not be restarted every minute: one start per five minutes at most. */
const START_EVERY_MS = 5 * 60_000;

export type EnsureHubServerResult = "answers" | "busy" | "started" | "started recently";

/**
 * Starts the resident hub server (`tools hub serve`, detached, plain TypeScript) when nothing listens on its socket,
 * so callers other than GenesisTools.app (the usage daemon) get its warm answers too. The app is not needed for
 * this, and nothing waits for the start: a caller that asked does its own work this time. A busy server is left
 * alone, and two starts cannot make two servers (the server's start runs under a lock and exits when another
 * answers). The server still exits after 10 minutes with no connection.
 */
export async function ensureHubServer({
    probe = () => askHubServer("health", { timeoutMs: 1000 }),
    start = () => spawnToolDetached(["hub", "serve"]),
    stampPath = toolDataDir("hub", "server-started-at"),
    now = Date.now(),
}: {
    probe?: () => Promise<HubServerProbe>;
    start?: () => number;
    stampPath?: string;
    now?: number;
} = {}): Promise<EnsureHubServerResult> {
    const { state } = await probe();

    if (state !== "absent") {
        return state;
    }

    const lastStart = await stat(stampPath).then(
        (status) => status.mtimeMs,
        (err: unknown) => {
            logger.debug({ err, stampPath }, "[hub-server] no earlier start recorded");
            return 0;
        }
    );

    if (now - lastStart < START_EVERY_MS) {
        return "started recently";
    }

    await Bun.write(stampPath, `${now}\n`);
    const pid = start();
    logger.info({ pid }, "[hub-server] nothing answered on the socket; started tools hub serve");
    return "started";
}
