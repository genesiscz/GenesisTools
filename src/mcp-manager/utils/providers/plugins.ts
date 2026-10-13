import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import type { UnifiedMCPServerConfig } from "./types.js";

/** One MCP server that a plugin declares in its manifest or its `.mcp.json`. */
export interface PluginMcpDeclaration {
    name: string;
    config: UnifiedMCPServerConfig;
}

/** `expo@claude-plugins-official` gives `{ plugin: "expo", marketplace: "claude-plugins-official" }`. */
export function splitPluginId(pluginId: string): { plugin: string; marketplace: string } | null {
    const at = pluginId.indexOf("@");

    if (at <= 0 || at === pluginId.length - 1) {
        return null;
    }

    return { plugin: pluginId.slice(0, at), marketplace: pluginId.slice(at + 1) };
}

/** The newest version folder under a plugin cache folder (`.../expo/1.13.6`), by numeric-aware name order. */
export function latestVersionDir(dir: string): string | null {
    if (!existsSync(dir)) {
        return null;
    }

    const versions = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = versions.at(-1);

    return latest ? path.join(dir, latest) : null;
}

/** Parse a JSON file. A missing file is `undefined`; a file that does not parse throws. */
export async function readJsonFileIfExists(filePath: string): Promise<unknown> {
    if (!existsSync(filePath)) {
        return undefined;
    }

    return SafeJSON.parse(await readFile(filePath, "utf-8"));
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function pluginServerToUnified(raw: Record<string, unknown>): UnifiedMCPServerConfig {
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const url = typeof raw.url === "string" ? raw.url : undefined;
    const declaredType = raw.type === "stdio" || raw.type === "sse" || raw.type === "http" ? raw.type : undefined;

    return {
        type: declaredType ?? (command ? "stdio" : "http"),
        ...(command ? { command } : {}),
        ...(Array.isArray(raw.args) ? { args: raw.args } : {}),
        ...(isStringRecord(raw.env) ? { env: raw.env } : {}),
        ...(url ? { url } : {}),
        ...(isStringRecord(raw.headers) ? { headers: raw.headers } : {}),
    };
}

/**
 * The MCP servers a plugin folder declares. The manifest's `mcpServers` wins: a path relative to the
 * plugin folder, or an inline map. Without it the harness reads `.mcp.json`, and some plugins ship
 * `mcp.json`. A file may wrap the map in `mcpServers` or be the map itself.
 */
export async function readPluginMcpServers(pluginDir: string, manifestPath: string): Promise<PluginMcpDeclaration[]> {
    const manifest = await readJsonFileIfExists(manifestPath);
    const declared = isObject(manifest) ? manifest.mcpServers : undefined;
    let servers: unknown = declared;

    if (!isObject(declared)) {
        const candidates =
            typeof declared === "string"
                ? [path.resolve(pluginDir, declared)]
                : [path.join(pluginDir, ".mcp.json"), path.join(pluginDir, "mcp.json")];
        const file = candidates.find((candidate) => existsSync(candidate));

        if (!file) {
            return [];
        }

        const parsed = await readJsonFileIfExists(file);
        servers = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
    }

    if (!isObject(servers)) {
        return [];
    }

    const result: PluginMcpDeclaration[] = [];

    for (const [name, raw] of Object.entries(servers)) {
        if (isObject(raw) && (typeof raw.command === "string" || typeof raw.url === "string")) {
            result.push({ name, config: pluginServerToUnified(raw) });
        }
    }

    return result;
}
