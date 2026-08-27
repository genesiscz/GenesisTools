import { join } from "node:path";
import { stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import { env } from "@genesiscz/utils/env";
import { parseTranscriptLine } from "../parse";
import type { DriverUsageEvent, MonitorDriver } from "./types";

/**
 * Claude Code transcripts: `~/.claude/projects/**\/*.jsonl`, one JSON object per
 * line, usage on `message.usage` of `type: "assistant"` lines. Mirrors
 * ccusage's claude adapter (`rust/adapters/claude/src/lib.rs`), which reads the
 * same four token fields and dedups on the message id.
 *
 * Anthropic reports `input_tokens` already NET of cache, so the four fields are
 * disjoint and no subtraction is needed here (unlike codex and grok).
 */
export const claudeDriver: MonitorDriver = {
    id: "claude",

    roots(home: string): string[] {
        const roots = [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
        const configDir = env.paths.getClaudeConfigDir();

        if (configDir) {
            const extra = join(configDir, "projects");

            if (!roots.includes(extra)) {
                roots.push(extra);
            }
        }

        return roots;
    },

    isTranscript(name: string): boolean {
        return name.endsWith(".jsonl");
    },

    // Subagent transcripts nest below the project directory.
    maxDepth: 6,

    createParser() {
        return {
            parseLine(line: string, emit: (event: DriverUsageEvent) => void): void {
                // Cheap prefilter before the JSON parse. About 72% of transcript lines
                // are user, tool-result and system records that `parseTranscriptLine`
                // discards on `type !== "assistant"` anyway, after paying for a full
                // parse. Measured on a 94.5 MB / 35,170-line transcript: 106 ms
                // parse-all vs 46 ms prefiltered, identical hit counts. The grok
                // driver and ccusage (`LinePrefilter`) do the same.
                if (!line.includes('"type":"assistant"')) {
                    return;
                }

                const event = parseTranscriptLine(line);

                if (!event) {
                    return;
                }

                emit({
                    id: event.messageId,
                    model: event.model,
                    timestamp: event.timestamp,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheCreationTokens: event.cacheCreationTokens,
                    cacheReadTokens: event.cacheReadTokens,
                });
            },
            snapshot(): unknown {
                return undefined;
            },
        };
    },

    priceCandidates(model: string): string[] {
        const base = stripModelVariantSuffix(model);

        return base ? [model, base] : [model];
    },
};
