import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, type Storage } from "@genesiscz/utils/storage/storage";
import { type AiConfigData, aiConfigSchema } from "./schema";

/**
 * A copy of `defaults` in a file no pre-v4 binary knows about.
 *
 * When an old binary writes `config.json` (its `applyDefaults` rebuilds the
 * document from a fixed v3 key list), the v4 `defaults` block is the one part
 * of the config that does not survive: accounts pass through by reference, but
 * `defaults` is dropped and `defaultAccounts` comes back empty. The hybrid
 * repair in the v4 migration restores it from this snapshot, so an old-code
 * write costs nothing rather than every task/app default.
 *
 * The snapshot holds refs and model names only — never credentials — so it
 * needs no vault and no special mode.
 */
const SNAPSHOT_FILE = "defaults.v4.json";

const defaultsSchema = aiConfigSchema.shape.defaults;

export function snapshotPath(storage: Storage): string {
    return join(storage.getBaseDir(), SNAPSHOT_FILE);
}

export function writeDefaultsSnapshot(storage: Storage, defaults: AiConfigData["defaults"]): void {
    try {
        atomicWriteFileSync(snapshotPath(storage), SafeJSON.stringify(defaults, null, 2) ?? "{}");
    } catch (err) {
        // Best-effort: a failed snapshot must never fail the config write it rides on.
        logger.warn({ err }, "ai-config: could not write the defaults snapshot");
    }
}

export function readDefaultsSnapshot(storage: Storage): AiConfigData["defaults"] | undefined {
    const path = snapshotPath(storage);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = defaultsSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

        if (!parsed.success) {
            logger.warn({ path, issues: parsed.error.issues.length }, "ai-config: defaults snapshot unreadable");
            return undefined;
        }

        return parsed.data;
    } catch (err) {
        logger.warn({ err, path }, "ai-config: defaults snapshot unreadable");
        return undefined;
    }
}
