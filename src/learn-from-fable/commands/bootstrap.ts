import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { input } from "@inquirer/prompts";
import { FABLE_CONFIG_PATH, FABLE_LOCAL_DIR, loadFableConfig, saveFableConfig } from "../lib/config";

export interface BootstrapOptions {
    packPath?: string;
}

/** GT_FABLE_PACK_PATH when set, otherwise a folder in the user's home. */
function defaultPackPath(): string {
    return env.paths.getFablePackPath() ?? join(homedir(), "FablePack");
}

export async function bootstrapCommand(options: BootstrapOptions): Promise<void> {
    const existing = loadFableConfig();
    if (existing && !options.packPath) {
        out.log.info(`Config OK: ${FABLE_CONFIG_PATH}`);
        out.log.info(`packPath: ${existing.packPath} (exists: ${existsSync(existing.packPath)})`);
        return;
    }

    let packPath = options.packPath;
    if (!packPath) {
        if (!isInteractive()) {
            logger.error("--pack-path required in non-interactive mode (no config yet).");
            out.log.info(
                suggestCommand("tools learn-from-fable bootstrap", { add: ["--pack-path", defaultPackPath()] })
            );
            return;
        }

        packPath = await input({
            message: "Where should the Fable pack repo live?",
            default: defaultPackPath(),
        });
    }

    packPath = resolve(packPath);
    saveFableConfig({
        packPath,
        sessionsMirrorPath: join(FABLE_LOCAL_DIR, "sessions"),
        sessionSources: [resolve(homedir(), ".claude", "projects"), join(FABLE_LOCAL_DIR, "sessions")],
        notes: "Written by tools learn-from-fable bootstrap.",
    });
    out.log.success(`Config written: ${FABLE_CONFIG_PATH} → packPath ${packPath}`);
}
