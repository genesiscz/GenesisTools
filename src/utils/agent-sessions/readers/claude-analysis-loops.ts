import { basename } from "node:path";
import { claudeUsageOfRow } from "@genesiscz/utils/ai/usage/spend/parse";
import { isObject } from "@genesiscz/utils/object";
import { nonEmptyString } from "@genesiscz/utils/string";
import type { LoopSelection, SessionCall, SessionFacts, SessionLoop } from "../analysis-types";
import { forEachTranscriptLine, isoOf, parseRow } from "./analysis-lines";
import {
    claudeAgentOwner,
    claudeSubagentIdOf,
    claudeSubagentLead,
    claudeSubagentTranscripts,
    readClaudeSubagentMeta,
} from "./claude-paths";

type Row = Record<string, unknown>;

export function claudeCall(row: Row): SessionCall | null {
    const event = claudeUsageOfRow(row);
    const t = event && isoOf(event.timestamp);
    if (!event || !t || event.model === "<synthetic>") {
        return null;
    }

    return {
        id: event.messageId,
        t,
        model: event.model,
        input: event.inputTokens,
        output: event.outputTokens,
        cacheRead: event.cacheReadTokens,
        cacheWrite: event.cacheCreationTokens,
        ...(event.cacheCreation1hTokens === undefined ? {} : { cacheWrite1h: event.cacheCreation1hTokens }),
        ...(event.serviceTier ? { serviceTier: event.serviceTier } : {}),
        sidechain: event.isSidechain === true,
        aggregate: false,
    };
}

export function decodeClaudeRow(line: string, path: string): Row | null {
    const row = parseRow(line, path);
    if (row?.type === "assistant" && typeof row.message === "string") {
        row.message = parseRow(row.message, path);
    }

    return row;
}

export function isCompactBoundary(row: Row): boolean {
    return row.type === "system" && row.subtype === "compact_boundary";
}

export function contextAfter(call: SessionCall): number {
    return call.input + call.cacheRead + call.cacheWrite + call.output;
}

export function lastClaudeContext(records: readonly Row[]): number | null {
    for (let i = records.length - 1; i >= 0; i--) {
        const row = records[i];
        if (isCompactBoundary(row)) {
            const post = isObject(row.compactMetadata) ? row.compactMetadata.postTokens : undefined;
            return typeof post === "number" && post >= 0 ? post : null;
        }

        const call = claudeCall(row);
        if (call) {
            return contextAfter(call);
        }
    }

    return null;
}

function loopsOf(path: string, selection: LoopSelection): SessionLoop[] {
    const parent = claudeSubagentLead(path);
    const selectedAgent = parent && claudeSubagentIdOf(basename(path));
    const main: SessionLoop[] =
        selection.main === false || selectedAgent
            ? []
            : [
                  {
                      id: basename(path, ".jsonl"),
                      kind: "main",
                      files: [path],
                      agentType: null,
                      teamName: null,
                  },
              ];

    if (selection.agents === false && !selectedAgent) {
        return main;
    }

    const agents = new Map<string, SessionLoop>();
    for (const file of claudeSubagentTranscripts(parent?.transcript ?? path)) {
        if (selectedAgent && file.agentId !== selectedAgent) {
            continue;
        }
        const meta = readClaudeSubagentMeta(file.meta);
        const owner = claudeAgentOwner(meta);
        const loop: SessionLoop = agents.get(file.agentId) ?? {
            id: file.agentId,
            kind: owner.owner,
            files: [],
            agentType: null,
            teamName: null,
        };
        if (file.runId) {
            // A revival writes the same id directly in subagents/. Its original run comes first.
            loop.kind = "workflow";
            loop.files.unshift(file.transcript);
        } else {
            loop.files.push(file.transcript);
        }

        loop.agentType ??= nonEmptyString(meta.agentType);
        loop.teamName ??= owner.teamName ?? null;
        agents.set(file.agentId, loop);
    }

    return [...main, ...agents.values()];
}

export interface LoopRow {
    row: Row;
    path: string;
    line: number;
}

export interface LoopCollector<T> {
    visit: (entry: LoopRow) => void;
    finish: () => T;
}

/** Keep a loop's state across revival files. Replayed rows keep their first file and physical line. */
export async function readClaudeLoops<T>(
    path: string,
    selection: LoopSelection,
    collector: (loop: SessionLoop) => LoopCollector<T>
): Promise<SessionFacts<T>> {
    const items: T[] = [];
    for (const loop of loopsOf(path, selection)) {
        const read = collector(loop);
        const seen = loop.files.length > 1 ? new Set<string>() : null;
        for (const file of loop.files) {
            const failed = await forEachTranscriptLine(file, (raw, line) => {
                if (raw.length > 200_000 && raw.startsWith('{"type":"api-request')) {
                    return;
                }

                const row = decodeClaudeRow(raw, file);
                if (!row || (loop.kind === "main" && row.isSidechain === true)) {
                    return;
                }

                if (seen && typeof row.uuid === "string") {
                    if (seen.has(row.uuid)) {
                        return;
                    }

                    seen.add(row.uuid);
                }

                read.visit({ row, path: file, line });
            });
            if (failed) {
                return { supported: false, reason: failed };
            }
        }

        items.push(read.finish());
    }
    return { supported: true, items };
}
