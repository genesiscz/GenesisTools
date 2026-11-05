import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

const log = logger.child({ component: "mobile.idb" });

// idb_companion logs its whole environment to a world-readable file, so it gets only what it needs.
const IDB_ENV_KEYS = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DEVELOPER_DIR",
];

function idbEnv(): Record<string, string | undefined> {
    const all = env.getProcessEnv();
    return Object.fromEntries(IDB_ENV_KEYS.map((key) => [key, all[key]]));
}

export function idbAvailable(): boolean {
    return Bun.which("idb") !== null;
}

/** Runs `idb <args>`; the stdout, or null when idb failed (the reason is in the log). */
export async function idb(args: string[], timeoutMs = 15_000): Promise<string | null> {
    const result = await boundedCommand({ command: ["idb", ...args], timeoutMs, environment: idbEnv() });

    if (result.status !== 0) {
        const reason = result.stderr.trim().split("\n").at(-1) ?? result.error?.message ?? "";
        const hint = reason.includes("SimulatorKit")
            ? " (Xcode 27 moved SimulatorKit: brew upgrade idb-companion && idb kill)"
            : "";
        log.debug({ args, reason: `${reason}${hint}` }, "idb failed");
        return null;
    }

    return result.stdout;
}

/**
 * Pre-approves permissions simctl cannot grant (`camera`, `notification`, `url` with a scheme). Returns whether idb
 * accepted it.
 */
export async function idbApprove(options: {
    udid: string;
    bundleId: string;
    services: string[];
    scheme?: string;
}): Promise<boolean> {
    const args = ["approve", "--udid", options.udid, ...(options.scheme ? ["--scheme", options.scheme] : [])];
    return (await idb([...args, options.bundleId, ...options.services], 30_000)) !== null;
}
