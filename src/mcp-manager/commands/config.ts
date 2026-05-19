import { existsSync } from "node:fs";
import { logger } from "@app/logger";
import { getUnifiedConfigPath } from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { isInteractive } from "@app/utils/cli";
import { Storage } from "@app/utils/storage";

// Lazy (not a module-level singleton) so it re-reads GENESIS_TOOLS_HOME at
// use time — production identical, lets the test suite sandbox the path.
const mcpStorage = (): Storage => new Storage("mcp-manager");

export interface ConfigOptions {
    path?: boolean; // Only show path, don't open editor
}

/**
 * Open the unified config file in the user's editor
 * @param options.path - If true, only prints the path without opening
 */
export async function openConfig(options: ConfigOptions = {}): Promise<void> {
    await mcpStorage().ensureDirs();
    const configPath = getUnifiedConfigPath();

    // Only create default config if file doesn't exist on disk.
    // Don't rely on getConfig() returning null — that also happens on parse errors,
    // and we must not overwrite a corrupted config (user can fix it in editor).
    if (!existsSync(configPath)) {
        const defaultConfig: UnifiedMCPConfig = {
            mcpServers: {},
        };
        // Defense-in-depth (post-incident hardening): this is the ONLY
        // unified-config writer that doesn't go through writeUnifiedConfig()
        // (which always backs up first). It's guarded by !existsSync above,
        // but guard the TOCTOU window too — if the file materialised between
        // the check and here, back it up via the same BackupManager
        // mechanism before the default write, so an empty default can never
        // silently replace a populated config without a recoverable backup.
        if (existsSync(configPath)) {
            await new BackupManager().createBackup(configPath, "unified");
        }

        await mcpStorage().setConfig(defaultConfig);
        logger.info(`Created default config at ${configPath}`);
    }

    // Always show the path first
    logger.info(`Config file: ${configPath}`);

    // If --path flag or non-interactive, just show the path and exit
    if (options.path || !isInteractive()) {
        return;
    }

    // Try to open in editor
    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    // Split editor command in case it has arguments (e.g., "code --wait")
    const editorParts = editor.split(" ");
    const proc = Bun.spawn({
        cmd: [...editorParts, configPath],
        stdio: ["ignore", "pipe", "pipe"],
    });

    await proc.exited;
}
