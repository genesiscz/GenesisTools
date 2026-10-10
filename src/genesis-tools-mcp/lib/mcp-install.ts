import { installServer } from "@app/mcp-manager/commands/install";
import { ClaudeProvider } from "@app/mcp-manager/utils/providers/claude.js";
import { CodexProvider } from "@app/mcp-manager/utils/providers/codex.js";
import { CursorProvider } from "@app/mcp-manager/utils/providers/cursor.js";
import { GeminiProvider } from "@app/mcp-manager/utils/providers/gemini.js";
import { GrokProvider } from "@app/mcp-manager/utils/providers/grok.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";

export interface InstallArgs {
    serverName: string;
    commandOrUrl: string;
    options: { type: string; provider: string };
}

/** The minimal read surface {@link genesisToolsMcpRegistration} needs, so a test never touches ~/.claude.json. */
export interface McpRegistrationReader {
    configExists: () => Promise<boolean>;
    readConfig: () => Promise<{ mcpServers?: Record<string, unknown> }>;
}

function defaultClaudeReader(): McpRegistrationReader {
    const provider = new ClaudeProvider();
    return {
        configExists: () => provider.configExists(),
        readConfig: () => provider.readConfig(),
    };
}

/**
 * Is the genesis-tools MCP server already registered with Claude Code? Read-only: never
 * installs, never writes — a diagnostic must never mutate (D4, round 2).
 */
/** "no-config": Claude Code has no config file yet, so there is nothing to register the server in. */
export type McpRegistration = "registered" | "not-registered" | "no-config";

export async function genesisToolsMcpRegistration(
    reader: McpRegistrationReader = defaultClaudeReader()
): Promise<McpRegistration> {
    if (!(await reader.configExists())) {
        return "no-config";
    }

    const config = await reader.readConfig();
    return config.mcpServers?.["genesis-tools"] ? "registered" : "not-registered";
}

/** Mirrors the private getProviders() in src/mcp-manager/index.ts (not exported). */
function buildProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider(), new GrokProvider()];
}

/**
 * The harnesses this server is installed into. Grok's entry is `[mcp_servers.genesis-tools]` in ~/.grok/config.toml
 * (`command`, `args`, optional `env`), written by mcp-manager's GrokProvider, whose `installServer` reads the file and
 * replaces only that one server, so the rest of the config survives.
 */
export const INSTALL_AGENTS = ["claude", "codex", "grok"] as const;
export type InstallAgent = (typeof INSTALL_AGENTS)[number];

function isInstallAgent(value: string): value is InstallAgent {
    return (INSTALL_AGENTS as readonly string[]).includes(value);
}

export function buildInstallArgs(o: { agent?: string }): InstallArgs {
    const agent = o.agent ?? "claude";

    if (!isInstallAgent(agent)) {
        throw new Error(`--agent must be one of ${INSTALL_AGENTS.join(", ")}, not "${agent}"`);
    }

    const provider = agent;
    // Stable global command (not the ephemeral worktree path) so the registration survives.
    return {
        serverName: "genesis-tools",
        commandOrUrl: toolCommand("genesis-tools-mcp"),
        options: { type: "stdio", provider },
    };
}

/**
 * The canonical registration path (D4, round 2): `tools genesis-tools-mcp install` is this
 * command; `tools claude mcp install` is only an alias of it. `tools update`'s interactive
 * offer calls this function directly, never by spawning the CLI.
 *
 * 🛑 `installServer` is the mcp-manager command's body and ends the PROCESS (`process.exit`) when
 * the target provider has no config file. Every argument it would otherwise prompt or exit for is
 * fixed here, so that is the one exit left; it is checked first and thrown as an error instead, so
 * an update that calls this keeps running. `providers` is injected only by tests.
 */
export async function installGenesisToolsMcp(
    options: { agent?: string; providers?: MCPProvider[] } = {}
): Promise<void> {
    const a = buildInstallArgs(options);
    const providers = options.providers ?? buildProviders();
    const target = providers.find((provider) => provider.getName().toLowerCase() === a.options.provider);

    if (!target || !(await target.configExists())) {
        const where = target ? ` at ${target.getConfigPath()}` : "";
        throw new Error(
            `${a.options.provider} has no config file${where}, so there is nothing to register the server in. Start ${a.options.provider} once, then run \`${toolCommand("genesis-tools-mcp install")}\`.`
        );
    }

    await installServer(a.serverName, a.commandOrUrl, providers, a.options);
}

export function registerMcpInstallCommand(mcp: Command): void {
    mcp.command("install")
        .description("Register the genesis-tools MCP server with Claude (or Codex / Grok via --agent)")
        .option("--agent <name>", INSTALL_AGENTS.join("|"), "claude")
        .action(async (o: { agent?: string }) => {
            await installGenesisToolsMcp(o);
        });
}
