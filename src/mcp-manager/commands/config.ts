import { Storage } from "@app/utils/storage";
import logger from "@app/logger";
import type { UnifiedMCPConfig } from "../utils/providers/types.js";
import { getUnifiedConfigPath } from "../utils/config.utils.js";

const storage = new Storage("mcp-manager");

/**
 * Open the unified config file in the user's editor
 */
export async function openConfig(): Promise<void> {
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

    // Try to open in editor
    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    // Split editor command in case it has arguments (e.g., "code --wait")
    const editorParts = editor.split(" ");
    const proc = Bun.spawn({
        cmd: [...editorParts, configPath],
        stdio: ["ignore", "pipe", "pipe"],
    });

    await proc.exited;
    logger.info(`Config file: ${configPath}`);
}
