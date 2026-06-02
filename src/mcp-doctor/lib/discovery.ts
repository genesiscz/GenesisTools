import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { ConfigSource, NormalizedServer } from "./types";

interface RawStdioDef {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

interface RawRemoteDef {
    url?: string;
    type?: string;
}

type RawServerDef = RawStdioDef & RawRemoteDef & Record<string, unknown>;

export interface RawConfig {
    mcpServers?: Record<string, RawServerDef>;
}

export interface ConfigBlobs {
    claude: RawConfig | null;
    mcp: RawConfig | null;
    cursor: RawConfig | null;
}

function normalizeOne(name: string, def: RawServerDef, source: ConfigSource): NormalizedServer {
    if (typeof def.command === "string" && def.command.length > 0) {
        return {
            name,
            transport: "stdio",
            source,
            command: def.command,
            args: Array.isArray(def.args) ? def.args : [],
            env: def.env ?? {},
            cwd: def.cwd,
        };
    }

    if (typeof def.url === "string" && def.url.length > 0) {
        const transport = def.type === "sse" ? "sse" : "http";
        return { name, transport, source, url: def.url };
    }

    return {
        name,
        transport: "stdio",
        source,
        invalidReason: "missing both 'command' (stdio) and 'url' (remote)",
    };
}

export function mergeServers(blobs: ConfigBlobs): NormalizedServer[] {
    const byName = new Map<string, NormalizedServer>();
    const layers: { config: RawConfig | null; source: ConfigSource }[] = [
        { config: blobs.claude, source: "~/.claude.json" },
        { config: blobs.mcp, source: ".mcp.json" },
        { config: blobs.cursor, source: ".cursor/mcp.json" },
    ];

    for (const { config, source } of layers) {
        const map = config?.mcpServers;
        if (!map) {
            continue;
        }

        for (const [name, def] of Object.entries(map)) {
            const next = normalizeOne(name, def, source);
            const prev = byName.get(name);
            if (prev) {
                next.overrides = prev.source;
            }

            byName.set(name, next);
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readJsonFile(path: string): Promise<RawConfig | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        logger.debug({ path }, "mcp-doctor: config file absent, skipping");
        return null;
    }

    try {
        return SafeJSON.parse(await file.text()) as RawConfig;
    } catch (err) {
        logger.warn({ path, err }, "mcp-doctor: failed to parse config file");
        return null;
    }
}

export async function readConfigSources(opts: { home?: string; projectDir: string }): Promise<ConfigBlobs> {
    const home = opts.home ?? homedir();
    const [claude, mcp, cursor] = await Promise.all([
        readJsonFile(join(home, ".claude.json")),
        readJsonFile(join(opts.projectDir, ".mcp.json")),
        readJsonFile(join(opts.projectDir, ".cursor", "mcp.json")),
    ]);

    return { claude, mcp, cursor };
}
