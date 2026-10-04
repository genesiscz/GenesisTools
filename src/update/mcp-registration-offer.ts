import type { McpRegistration } from "@app/genesis-tools-mcp/lib/mcp-install";
import { logger } from "@genesiscz/utils/logger";

export interface McpRegistrationOfferDeps {
    registration: () => Promise<McpRegistration>;
    isTty: () => boolean;
    confirmRegister: () => Promise<boolean>;
    register: () => Promise<void>;
    log: (message: string) => void;
}

/**
 * D4, round 2: `tools update` offers to register the genesis-tools MCP server with Claude Code
 * the moment it notices it is not registered. In a TTY it asks (default no); without one it
 * prints a single hint line and moves on. `registration` must be read-only. Registration is
 * optional, so nothing here may stop the update: a check that throws (an unreadable or malformed
 * Claude config) is reported with the manual command, and the update goes on. With no Claude
 * config yet there is nothing to register in, so it says to start Claude Code first and never asks.
 */
export async function offerMcpRegistration(deps: McpRegistrationOfferDeps): Promise<void> {
    let registration: McpRegistration;

    try {
        registration = await deps.registration();
    } catch (error) {
        logger.warn({ error }, "update: could not check the genesis-tools MCP registration");
        deps.log(
            `Could not check whether the genesis-tools MCP server is registered: ${error instanceof Error ? error.message : String(error)}. Register with: tools genesis-tools-mcp install`
        );
        return;
    }

    if (registration === "registered") {
        return;
    }

    if (registration === "no-config") {
        deps.log(
            "Claude Code has no config file yet. Start Claude Code once, then register the genesis-tools MCP server with: tools genesis-tools-mcp install"
        );
        return;
    }

    if (!deps.isTty()) {
        deps.log(
            "genesis-tools MCP server is not registered with Claude Code. Register with: tools genesis-tools-mcp install"
        );
        return;
    }

    const confirmed = await deps.confirmRegister();

    if (!confirmed) {
        return;
    }

    try {
        await deps.register();
    } catch (error) {
        logger.warn({ error }, "update: genesis-tools MCP registration failed");
        deps.log(
            `Could not register the MCP server: ${error instanceof Error ? error.message : String(error)}. Retry with: tools genesis-tools-mcp install`
        );
    }
}
