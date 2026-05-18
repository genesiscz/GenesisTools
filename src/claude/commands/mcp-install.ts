import { installServer } from "@app/mcp-manager/commands/install";
import { ClaudeProvider } from "@app/mcp-manager/utils/providers/claude.js";
import { CodexProvider } from "@app/mcp-manager/utils/providers/codex.js";
import { CursorProvider } from "@app/mcp-manager/utils/providers/cursor.js";
import { GeminiProvider } from "@app/mcp-manager/utils/providers/gemini.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import type { Command } from "commander";

export interface InstallArgs {
    serverName: string;
    commandOrUrl: string;
    options: { type: string; provider: string };
}

/** Mirrors the private getProviders() in src/mcp-manager/index.ts (not exported). */
function buildProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];
}

export function buildInstallArgs(o: { agent?: string }): InstallArgs {
    const provider = o.agent === "codex" ? "codex" : "claude";
    // Stable global command (not the ephemeral worktree path) so the registration survives.
    return { serverName: "genesis-tools", commandOrUrl: "tools claude mcp", options: { type: "stdio", provider } };
}

export function registerMcpInstallCommand(mcp: Command): void {
    mcp.command("install")
        .description("Register the genesis-tools MCP server with Claude (or Codex via --agent codex)")
        .option("--agent <name>", "claude|codex", "claude")
        .action(async (o: { agent?: string }) => {
            const a = buildInstallArgs(o);
            await installServer(a.serverName, a.commandOrUrl, buildProviders(), a.options);
        });
}
