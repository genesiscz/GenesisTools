import logger from "@app/logger";
import { getUnifiedConfigPath } from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { Storage } from "@app/utils/storage";

const storage = new Storage("mcp-manager");

export interface ConfigOptions {
    path?: boolean; // Only show path, don't open editor
}

/**
 * Open the unified config file in the user's editor
 * @param options.path - If true, only prints the path without opening
 */
export async function openConfig(options: ConfigOptions = {}): Promise<void> {
    await storage.ensureDirs();
    const configPath = getUnifiedConfigPath();

    // Create default config if it doesn't exist
    const existingConfig = await storage.getConfig<UnifiedMCPConfig>();
    if (!existingConfig) {
        const defaultConfig: UnifiedMCPConfig = {
            mcpServers: {},
        };
        await storage.setConfig(defaultConfig);
        logger.info(`Created default config at ${configPath}`);
    }

    // Always show the path first
    logger.info(`Config file: ${configPath}`);

    // If --path flag, just show the path and exit
    if (options.path) {
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
