import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { StatuslineConfig } from "./types";

/**
 * Defaults reproduce Martin's `~/.claude/statusline.sh` plus the graft wrapper around it,
 * so a fresh install renders the same line the shell script did.
 */
export function defaultStatuslineConfig(): StatuslineConfig {
    return {
        showDelta: true,
        showSession: true,
        showAccount: true,
        showGit: true,
        graft: { enabled: true, shim: join(homedir(), ".claude", "helpers", "graft-statusline.cjs"), ttlMs: 10_000 },
        metricsPost: { enabled: true, url: "http://localhost:8765/statusline", timeoutMs: 300 },
        gitTtlMs: 5_000,
        extends: null,
        fallbackColumns: 80,
        previousCommand: null,
    };
}

export function statuslineConfigPath(): string {
    return aiDataDir("statusline", "config.json");
}

export async function loadStatuslineConfig(path = statuslineConfigPath()): Promise<StatuslineConfig> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return defaultStatuslineConfig();
    }

    try {
        const parsed = SafeJSON.parse(await file.text(), { unbox: true }) as Partial<StatuslineConfig> | undefined;

        return mergeStatuslineConfig(defaultStatuslineConfig(), parsed ?? {});
    } catch (error) {
        logger.warn({ err: error, path }, "statusline config unreadable, using defaults");
        return defaultStatuslineConfig();
    }
}

export async function saveStatuslineConfig(config: StatuslineConfig, path = statuslineConfigPath()): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, `${SafeJSON.stringify(config, { strict: true }, 2)}\n`);
    logger.debug({ path }, "statusline config saved");
}

export function mergeStatuslineConfig(base: StatuslineConfig, patch: Partial<StatuslineConfig>): StatuslineConfig {
    return {
        ...base,
        ...patch,
        graft: { ...base.graft, ...patch.graft },
        metricsPost: { ...base.metricsPost, ...patch.metricsPost },
        extends: patch.extends === undefined ? base.extends : patch.extends,
    };
}
