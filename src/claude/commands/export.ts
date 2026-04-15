import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeSessionFormatter } from "@app/utils/claude/ClaudeSessionFormatter";
import { IncludeSpec } from "@app/utils/claude/cli/dsl";
import { parseJsonlTranscript } from "@app/utils/claude/index";
import { PROJECTS_DIR } from "@app/utils/claude/projects";
import type { ConversationMessage } from "@app/utils/claude/types";
import type { Command } from "commander";
import pc from "picocolors";

interface ExportOptions {
    output?: string;
    format: string;
    colors: boolean;
    include?: string;
    project?: string;
    all: boolean;
}

/**
 * Resolve a session ID (full UUID or prefix) to its JSONL file path.
 * Scans all project dirs under ~/.claude/projects/.
 */
function findSessionFile(sessionId: string, options: { project?: string; all?: boolean }): string | null {
    const dirs = getProjectDirs(options.project, options.all);
    const lowerPrefix = sessionId.toLowerCase();

    for (const dir of dirs) {
        try {
            for (const entry of readdirSync(dir)) {
                if (!entry.endsWith(".jsonl")) {
                    continue;
                }

                const name = entry.replace(".jsonl", "");

                if (name.toLowerCase() === lowerPrefix || name.toLowerCase().startsWith(lowerPrefix)) {
                    return resolve(dir, entry);
                }
            }
        } catch {
            // Skip unreadable dirs
        }
    }

    return null;
}

function getProjectDirs(projectPath?: string, _allProjects?: boolean): string[] {
    if (projectPath) {
        const dir = resolve(PROJECTS_DIR, projectPath);
        return existsSync(dir) ? [dir] : [];
    }

    if (!existsSync(PROJECTS_DIR)) {
        return [];
    }

    try {
        return readdirSync(PROJECTS_DIR)
            .map((d) => resolve(PROJECTS_DIR, d))
            .filter((d) => {
                try {
                    return statSync(d).isDirectory();
                } catch {
                    return false;
                }
            });
    } catch {
        return [];
    }
}

export function registerExportCommand(program: Command): void {
    program
        .command("export <session-id>")
        .description("Export a Claude session to formatted output")
        .option("-o, --output <path>", "Output file path (default: stdout)")
        .option("-f, --format <type>", "Format: full, mini, raw (default: full)", "full")
        .option("--no-colors", "Strip ANSI colors (auto-stripped for file output)")
        .option("--include <spec>", "Content include spec (same as tail --include)")
        .option("-p, --project <name>", "Search in specific project directory")
        .option("--all", "Search all projects (default)", true)
        .action(async (sessionId: string, opts: ExportOptions) => {
            const filePath = findSessionFile(sessionId, {
                project: opts.project,
                all: opts.all,
            });

            if (!filePath) {
                console.error(pc.red(`Session not found: ${sessionId}`));
                console.error(pc.dim("Tip: use an 8-char prefix or full UUID from `tools claude history`"));
                process.exit(1);
            }

            const validFormats = ["full", "mini", "raw"];

            if (!validFormats.includes(opts.format)) {
                console.error(pc.red(`Invalid format "${opts.format}". Use: ${validFormats.join(", ")}`));
                process.exit(1);
            }

            const isRaw = opts.format === "raw";
            const useColors = opts.output ? false : opts.colors && (process.stdout.isTTY ?? false);

            const includeSpec = opts.include ? IncludeSpec.parse(opts.include) : IncludeSpec.defaults();

            const formatter = new ClaudeSessionFormatter({
                includeSpec,
                colors: useColors,
                outputFile: opts.output ? resolve(opts.output) : undefined,
                cliOutput: !opts.output,
                raw: isRaw,
                mode: isRaw ? undefined : (opts.format as "full" | "mini"),
            });

            const records = await parseJsonlTranscript<ConversationMessage>(filePath);

            for (const record of records) {
                formatter.format(record);
            }

            await formatter.close();

            if (opts.output) {
                console.error(pc.dim(`Exported ${records.length} records to ${opts.output}`));
            }
        });
}
