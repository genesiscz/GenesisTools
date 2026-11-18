#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditClaudeChanges } from "@genesiscz/utils/agent-sessions/readers/claude-changes-audit";
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

out.result({ ...totals, unreadable });
if (unreadable || !totals.sessions) {
    process.exitCode = 1;
}
