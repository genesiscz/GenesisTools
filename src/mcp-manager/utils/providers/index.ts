import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CursorProvider } from "./cursor.js";
import { GeminiProvider } from "./gemini.js";
import type { MCPProvider } from "./types.js";

/**
 * Every provider mcp-manager knows how to read. The single construction point,
 * shared by the mcp-manager CLI and programmatic consumers (`tools scripts`
 * builds its server registry from these instead of spawning `tools mcp-manager
 * list --json`).
 */
export function defaultProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];
}
