import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { autosaveDir, listAutosaveFiles, readAutosaveSession } from "@app/cmux/lib/autosave";
import { advanceScreenEpoch, pruneSavedScreens } from "@app/cmux/lib/screen-cache";
import { collectTerminalScreens } from "@app/cmux/lib/screen-collector";
import { rpc } from "@genesiscz/utils/cmux/lib/socket";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const args = process.argv.slice(2);
const controlDir = args[args.indexOf("--control-dir") + 1];
const ownerToken = args[args.indexOf("--owner-token") + 1];
if (
    !args.includes("--control-dir") ||
    !args.includes("--owner-token") ||
    !isAbsolute(controlDir ?? "") ||
    !/^[a-f\d-]{36}$/i.test(ownerToken ?? "")
) {
    throw new Error("Expected --control-dir <absolute path> --owner-token <UUID>");
}

mkdirSync(controlDir, { recursive: true, mode: 0o700 });
const marker = join(controlDir, "screens.enabled");
const pidPath = join(controlDir, "screens.pid.json");
const lock = join(controlDir, `screens.${ownerToken}.lock`);
const ownership = SafeJSON.stringify({ pid: process.pid, ownerToken });
let stopping = false;
function enabled(): boolean {
    if (stopping || !existsSync(marker)) {
        return false;
    }

    try {
        return readFileSync(marker, "utf8").trim() === ownerToken;
    } catch (error) {
        logger.debug({ error }, "[cmux-screens] enable marker unavailable");
        return false;
    }
}

if (!enabled()) {
    process.exit(0);
}

try {
    writeFileSync(lock, ownership, { flag: "wx", mode: 0o600 });
} catch (error) {
    logger.warn({ error }, "[cmux-screens] collector already owns this installation token");
    process.exit(1);
}

const temporaryPidPath = `${pidPath}.${ownerToken}.tmp`;
writeFileSync(temporaryPidPath, ownership, { mode: 0o600 });
renameSync(temporaryPidPath, pidPath);
process.on("SIGTERM", () => {
    stopping = true;
});
process.on("SIGINT", () => {
    stopping = true;
});
try {
    while (enabled()) {
        try {
            const session = readAutosaveSession();
            const previous = listAutosaveFiles(autosaveDir(), "previous")[0];
            const directory = join(controlDir, "screens");
            advanceScreenEpoch({ directory, epoch: previous ? `${previous.path}:${previous.mtimeMs}` : "initial" });
            const started = Date.now();
            const result = await collectTerminalScreens({
                session,
                directory,
                shouldContinue: enabled,
                journalDirectory: join(controlDir, "command-journal"),
                readText: async (surfaceId) => {
                    const result = await rpc<{ text: string }>(
                        "surface.read_text",
                        { surface_id: surfaceId, scrollback: false, lines: 200 },
                        { timeoutMs: 1000 }
                    );
                    return result.text;
                },
            });
            if (!enabled()) {
                break;
            }

            const cacheBytes = pruneSavedScreens({ directory });
            writeFileSync(
                join(controlDir, "screens.last-run.json"),
                SafeJSON.stringify({ ...result, durationMs: Date.now() - started, cacheBytes, atMs: Date.now() }),
                { mode: 0o600 }
            );
            logger.debug(result, "[cmux-screens] read-only collection finished");
        } catch (error) {
            logger.debug({ error }, "[cmux-screens] autosave or socket unavailable; retaining cached output");
        }

        for (let i = 0; i < 60 && enabled(); i++) {
            await Bun.sleep(250);
        }
    }
} finally {
    for (const path of [pidPath, lock]) {
        try {
            if (existsSync(path) && readFileSync(path, "utf8") === ownership) {
                unlinkSync(path);
            }
        } catch (error) {
            logger.debug({ error, path }, "[cmux-screens] collector ownership cleanup failed");
        }
    }
}
