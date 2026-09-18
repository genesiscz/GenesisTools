import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverTools, type ToolInfo } from "@app/tools/lib/discovery";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-route");

export const DESTRUCTIVE_PATHS = new Set([
    "control act",
    "control osascript",
    "git push",
    "jenkins",
    "chrome-devtools rm-cookie",
    "jev wake enable",
]);

export const ROUTE_ALIASES: Record<string, string> = {
    pr: "github review",
    review: "github review",
};

export function aliasNote(path: string): string {
    const aliases = Object.entries(ROUTE_ALIASES)
        .filter(([, target]) => path === target || path.startsWith(`${target} `))
        .map(([name]) => name);
    return aliases.length ? ` aliases: ${aliases.join(", ")}` : "";
}

export interface CatalogueCommand {
    path: string;
    description: string;
    argHint: string;
    destructive: boolean;
}

export interface CatalogueTool {
    name: string;
    oneLine: string;
    commands: CatalogueCommand[];
}

export interface ToolCatalogue {
    commit: string;
    tools: CatalogueTool[];
}

const COMMAND_RE = /\.command\(\s*["']([a-z][a-z0-9-]*)["']/g;

export function isDestructive(path: string): boolean {
    if (DESTRUCTIVE_PATHS.has(path)) {
        return true;
    }

    return [...DESTRUCTIVE_PATHS].some(
        (item) => path === item || path.startsWith(`${item} `) || item.startsWith(`${path} `)
    );
}

function scanCommands(toolName: string, toolPath: string): CatalogueCommand[] {
    const dir = statSync(toolPath).isDirectory() ? toolPath : join(toolPath, "..");
    const files = [toolPath];
    const commandsDir = join(dir, "commands");
    if (existsSync(commandsDir) && statSync(commandsDir).isDirectory()) {
        for (const entry of readdirSync(commandsDir)) {
            if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
                files.push(join(commandsDir, entry));
            }
        }
    }

    const names = new Set<string>();
    for (const file of files) {
        if (!existsSync(file) || !statSync(file).isFile()) {
            continue;
        }

        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(COMMAND_RE)) {
            names.add(match[1]);
        }
    }

    if (!names.size) {
        return [
            {
                path: toolName,
                description: "",
                argHint: "",
                destructive: isDestructive(toolName),
            },
        ];
    }

    return [...names]
        .sort((left, right) => left.localeCompare(right))
        .map((name) => {
            const path = `${toolName} ${name}`;
            return {
                path,
                description: name,
                argHint: "",
                destructive: isDestructive(path) || isDestructive(toolName),
            };
        });
}

export function buildCatalogue(srcDir: string, commit = "worktree"): ToolCatalogue {
    const discovered = discoverTools(srcDir);
    log.debug({ toolCount: discovered.length, commit }, "Building Jev route catalogue");
    return {
        commit,
        tools: discovered.map((tool: ToolInfo) => ({
            name: tool.name,
            oneLine: tool.description,
            commands: scanCommands(tool.name, join(srcDir, tool.name)),
        })),
    };
}

export function flattenCatalogue(
    catalogue: ToolCatalogue
): Array<{ id: string; path: string; destructive: boolean; oneLine: string }> {
    const rows: Array<{ id: string; path: string; destructive: boolean; oneLine: string }> = [];
    for (const tool of catalogue.tools) {
        if (!tool.commands.length) {
            rows.push({
                id: tool.name,
                path: tool.name,
                destructive: isDestructive(tool.name),
                oneLine: tool.oneLine,
            });
            continue;
        }

        for (const command of tool.commands) {
            rows.push({
                id: command.path.replaceAll(" ", "."),
                path: command.path,
                destructive: command.destructive,
                oneLine: `${tool.oneLine} / ${command.description}${aliasNote(command.path)}`.trim(),
            });
        }
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id));
}
