import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/** A transcript larger than this is skipped: reading it costs more than its commands buy. */
export const MAX_TRANSCRIPT_BYTES = 40_000_000;

export function claudeProjectsDir(): string {
    return join(homedir(), ".claude", "projects");
}

interface ToolUseBlock {
    type?: string;
    name?: string;
    input?: { command?: unknown };
}

function transcriptsNewestFirst(root: string): string[] {
    const found: { path: string; mtimeMs: number }[] = [];

    const walk = (dir: string): void => {
        let entries: Dirent[];

        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            // A folder that vanished or cannot be read holds no commands we can replay.
            return;
        }

        for (const entry of entries) {
            const path = join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(path);
                continue;
            }

            if (!entry.name.endsWith(".jsonl")) {
                continue;
            }

            try {
                const stat = statSync(path);

                if (stat.size <= MAX_TRANSCRIPT_BYTES) {
                    found.push({ path, mtimeMs: stat.mtimeMs });
                }
            } catch {
                // Removed between the listing and the stat.
            }
        }
    };

    walk(root);

    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((item) => item.path);
}

function bashCommandsIn(line: string): string[] {
    if (!line.includes('"Bash"')) {
        return [];
    }

    let record: { message?: { content?: ToolUseBlock[] } };

    try {
        record = SafeJSON.parse(line, { strict: true }) as { message?: { content?: ToolUseBlock[] } };
    } catch {
        // A truncated transcript line contributes no command.
        return [];
    }

    const content = Array.isArray(record?.message?.content) ? record.message.content : [];

    return content
        .filter((block) => block.type === "tool_use" && block.name === "Bash")
        .map((block) => block.input?.command)
        .filter((command): command is string => typeof command === "string");
}

/**
 * The newest `limit` unique Bash commands from Claude Code transcripts, newest first. Read-only.
 * The commands are whatever was typed, inline secrets included: callers keep them in memory and
 * show at most a short first line.
 */
export function recentBashCommands(limit: number, root = claudeProjectsDir()): string[] {
    const seen = new Set<string>();
    const commands: string[] = [];

    for (const path of transcriptsNewestFirst(root)) {
        if (commands.length >= limit) {
            break;
        }

        let lines: string[];

        try {
            lines = readFileSync(path, "utf8").split("\n");
        } catch {
            continue;
        }

        for (let index = lines.length - 1; index >= 0 && commands.length < limit; index--) {
            for (const command of bashCommandsIn(lines[index] ?? "").reverse()) {
                if (commands.length < limit && !seen.has(command)) {
                    seen.add(command);
                    commands.push(command);
                }
            }
        }
    }

    return commands;
}
