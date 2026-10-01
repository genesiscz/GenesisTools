import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * Where GenesisTools is installed, for code that runs from a COPY of the plugin (the Claude and
 * Codex plugin caches hold `plugins/genesis-tools` only) and needs the full checkout, such as
 * fable-replace loading the TypeScript compiler. `plugins/genesis-tools/lib/locate-genesis-tools.ts`
 * reads this file; keep the two shapes in step.
 */
export interface InstallRecord {
    /** The main working tree: `package.json` and `node_modules` live here. */
    checkout: string;
    version: string;
    pluginVersion: string | null;
    recordedAt: string;
}

export const installRecordPath = (): string => genesisToolsDir("install.json");

const readJson = (file: string): unknown => SafeJSON.parse(readFileSync(file, "utf8"));

const versionOf = (file: string): string | null => {
    const parsed = readJson(file);
    return parsed !== null && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string"
        ? parsed.version
        : null;
};

/**
 * Write the record when it changed. Runs on every `tools` invocation, so it reads one small file
 * and writes only when the checkout or a version moved. A linked worktree (its `.git` is a file)
 * never becomes the install: worktrees are removed, and a removed checkout is a broken pointer.
 */
export function refreshInstallRecord(root: string): void {
    try {
        if (!statSync(join(root, ".git")).isDirectory()) {
            return;
        }

        const version = versionOf(join(root, "package.json")) ?? "unknown";
        let pluginVersion: string | null = null;
        try {
            pluginVersion = versionOf(join(root, "plugins", "genesis-tools", ".claude-plugin", "plugin.json"));
        } catch (err) {
            logger.debug({ err }, "install record: no plugin.json beside the checkout");
        }

        const file = installRecordPath();
        try {
            const current = readJson(file) as Partial<InstallRecord>;
            if (current.checkout === root && current.version === version && current.pluginVersion === pluginVersion) {
                return;
            }
        } catch (err) {
            logger.debug({ err, file }, "install record: none yet, writing it");
        }

        const record: InstallRecord = { checkout: root, version, pluginVersion, recordedAt: new Date().toISOString() };
        mkdirSync(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, `${SafeJSON.stringify(record, null, 4)}\n`);
        renameSync(temporary, file);
        logger.debug({ file, record }, "install record written");
    } catch (err) {
        logger.debug({ err, root }, "install record: not refreshed");
    }
}
