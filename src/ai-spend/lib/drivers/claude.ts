import { stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import {
    isNativeTranscript,
    nativeSessionRoots,
    nativeTranscriptMaxDepth,
} from "@genesiscz/utils/providers/session-paths";
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
        return nativeSessionRoots("claude", home);
    },

    isTranscript(name: string): boolean {
        return isNativeTranscript("claude", name);
    },

    // Subagent transcripts nest below the project directory.
    maxDepth: nativeTranscriptMaxDepth("claude"),

    createParser() {
        return {
            parseLine(line: string, emit: (event: DriverUsageEvent) => void): void {
                // Cheap prefilter before the JSON parse. About 72% of transcript lines
                // are user, tool-result and system records that `parseTranscriptLine`
                // discards on `type !== "assistant"` anyway, after paying for a full
                // parse. The grok driver and ccusage (`LinePrefilter`) do the same.
                //
                // The needle is the bare token, NOT `"type":"assistant"`: whitespace
                // may sit around the colon, and no serializer puts any inside the
                // string literal. So this is a strict superset of what the parser
                // accepts — it can let an extra line through to be rejected there,
                // and can never drop a billable one. Measured over 22,465 lines of a
                // 132 MB transcript, five passes: 7.9 ms for this, 21.3 ms for the
                // `/"type"\s*:\s*"assistant"/` regex, against ~106 ms to parse
                // every line. All three agree on 6,503 hits.
                if (!line.includes('"assistant"')) {
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
