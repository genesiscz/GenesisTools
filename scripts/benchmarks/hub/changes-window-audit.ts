#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { auditClaudeChanges, auditClaudeFacts } from "@genesiscz/utils/agent-sessions/readers/claude-changes-audit";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";

const files: Array<{ path: string; size: number; mtime: number }> = [];
let unreadable = 0;
for (const root of nativeSessionRoots("claude")) {
    try {
        for (const project of readdirSync(root, { withFileTypes: true })) {
            if (!project.isDirectory()) {
                continue;
            }
            const folder = join(root, project.name);
            for (const name of readdirSync(folder)) {
                if (!/\.jsonl(?:\.zst)?$/.test(name) || name.startsWith("agent-") || name === "sessions-index.jsonl") {
                    continue;
                }
                const path = join(folder, name);
                const { size, mtimeMs } = statSync(path);
                files.push({ path, size, mtime: mtimeMs });
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            unreadable++;
        }
    }
}

const totals: Record<string, number> = { sessions: 0, recentSubagents: 0, recentPhantomCapable: 0 };
for (const [index, file] of files.sort((a, b) => b.mtime - a.mtime).entries()) {
    try {
        if (process.argv.includes("--facts")) {
            const checks = auditClaudeFacts(file.path);
            totals.factsChecked = (totals.factsChecked ?? 0) + 1;
            totals.factsMismatch = (totals.factsMismatch ?? 0) + Number(Object.values(checks).some((ok) => !ok));
        }
        const counts = auditClaudeChanges(file.path);
        totals.sessions++;
        for (const [key, count] of Object.entries(counts)) {
            totals[key] = (totals[key] ?? 0) + count;
        }
        if (index < 30) {
            totals.recentSubagents += counts.subagents;
            totals.recentPhantomCapable += counts.phantomCapable;
        }
    } catch {
        unreadable++;
    }
}

if (process.argv.includes("--equal")) {
    const { excludedOf, turnChangesJson } = await import("../../../src/agents/lib/changes/tool-changes");
    const { changeLogPath, readChangeLog } = await import("@genesiscz/utils/agents/change-log");
    const { loadSessionChanges, loadRecentSessionChanges, lastChangedTurns, mergeTurnFiles } = await import(
        "@genesiscz/utils/session-changes"
    );
    const seen = new Set<string>();
    for (const file of [...files].sort((a, b) => b.size - a.size)) {
        const sessionId = basename(file.path).replace(/\.jsonl(?:\.zst)?$/, "");
        if (seen.has(sessionId)) {
            continue;
        }
        seen.add(sessionId);
        try {
            const log = readChangeLog(sessionId);
            const full = loadSessionChanges({ sessionId, log });
            if (!full.transcriptPath) {
                throw new Error("no full transcript for equality check");
            }
            for (const count of [1, 5, 20]) {
                let verificationMismatch = false;
                const render = (changes: typeof full) => {
                    const selected = lastChangedTurns(changes, count);
                    const files = mergeTurnFiles(selected);
                    const excluded = excludedOf(selected, files);
                    return SafeJSON.stringify(
                        turnChangesJson(
                            sessionId,
                            changeLogPath(sessionId),
                            {},
                            {
                                changes,
                                selected,
                                files,
                                excluded,
                                diffs: null,
                            }
                        ),
                        { strict: true }
                    );
                };
                const recent = loadRecentSessionChanges({
                    sessionId,
                    log,
                    count,
                    onRound: (round) => {
                        verificationMismatch ||= round.fallback === "verification mismatch";
                        if (round.fallback) {
                            totals.equalFallbacks = (totals.equalFallbacks ?? 0) + 1;
                        }
                    },
                });
                totals.equalChecked = (totals.equalChecked ?? 0) + 1;
                totals.equalMismatch =
                    (totals.equalMismatch ?? 0) + Number(verificationMismatch || render(full) !== render(recent));
            }
        } catch {
            unreadable++;
        }
        if (seen.size === 30) {
            break;
        }
    }
}

out.result({ ...totals, unreadable });
if (unreadable || !totals.sessions || totals.factsMismatch || totals.equalMismatch) {
    process.exitCode = 1;
}
