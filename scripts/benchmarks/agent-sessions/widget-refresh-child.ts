#!/usr/bin/env bun
/**
 * One fresh process that measures what the Widget roster worker pays per tick (`refreshWidgetIndex`), under the
 * scratch `GENESIS_TOOLS_HOME` the driver (`widget-refresh.ts`) set up with a copy of the history index, so the live
 * index is never written. The session roots are the live ones, read only. Prints one JSON object on stdout.
 *
 * - `tick.claude`: a change of the newest main Claude transcript (the scope a transcript write asks for).
 * - `tick.claudeAgents`: a change of the newest Claude sub-agent transcript of a lead the tree does not list.
 * - `tick.all`: the full refresh the safety tick asks for every fourth tick (the listing and the agents tree).
 * - `metadata.grownSmall` / `metadata.grownLarge`: one transcript's metadata read again after 64 KB more of real
 *   lines were appended, for a copy under the 10 MB full-read bound and one above it (scratch files, not the roots).
 *
 * CPU is this process's own (`process.cpuUsage`), median of the warm passes after one discarded pass.
 */
import {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withoutListingReuse } from "@genesiscz/utils/agent-sessions/listing-freshness";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { NativeSessionSource } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { refreshWidgetIndex, type WidgetRosterScope } from "../../../src/hub/lib/widget/roster-index";

const [scratch, passesArg] = process.argv.slice(2);

if (!scratch) {
    process.stderr.write("usage: widget-refresh-child.ts <scratch dir> [passes]\n");
    process.exit(2);
}

const passes = Number(passesArg ?? "5");
const reader = resolveHistoryProvider("claude").reader;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function cpuNow(): number {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
}

/** The newest `.jsonl` a pattern of folders holds, by mtime. */
function newest(paths: string[]): string {
    let best: { path: string; mtime: number } | undefined;

    for (const path of paths) {
        try {
            const mtime = statSync(path).mtimeMs;

            if (!best || mtime > best.mtime) {
                best = { path, mtime };
            }
        } catch {
            // A file that went away between the listing and the stat is not a candidate.
        }
    }

    if (!best) {
        throw new Error("no transcript found under the Claude roots");
    }

    return best.path;
}

function list(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

const mains: string[] = [];
const agents: string[] = [];

for (const root of reader.roots()) {
    for (const project of list(root)) {
        for (const entry of list(join(root, project))) {
            if (entry.endsWith(".jsonl")) {
                mains.push(join(root, project, entry));
            } else {
                for (const file of list(join(root, project, entry, "subagents"))) {
                    if (file.endsWith(".jsonl")) {
                        agents.push(join(root, project, entry, "subagents", file));
                    }
                }
            }
        }
    }
}

const liveMain = newest(mains);
const liveAgent = newest(agents);

async function tick(scope: WidgetRosterScope, path?: string): Promise<number> {
    const paths = new Map<WidgetRosterScope, string[]>(path ? [[scope, [path]]] : []);
    const started = cpuNow();
    await withoutListingReuse(() => refreshWidgetIndex(new Set([scope]), { paths }));
    return cpuNow() - started;
}

/** Complete lines of `from`, starting at `offset`, about `bytes` long; returns the text and the next offset. */
function realLines(from: string, offset: number, bytes: number): { text: Buffer; next: number } {
    const fd = openSync(from, "r");
    try {
        const buffer = Buffer.alloc(bytes + 4 * 1024 * 1024);
        const read = readSync(fd, buffer, 0, buffer.length, offset);
        let end = buffer.subarray(0, read).indexOf(10, Math.min(bytes, read - 1));

        if (end < 0) {
            end = buffer.subarray(0, read).lastIndexOf(10);
        }

        return { text: buffer.subarray(0, end + 1), next: offset + end + 1 };
    } finally {
        closeSync(fd);
    }
}

async function grownRead(label: string, initialBytes: number): Promise<number[]> {
    const root = join(scratch, `root-${label}`);
    const project = join(root, "-scratch-project");
    mkdirSync(project, { recursive: true });
    const file = join(project, "00000000-0000-4000-8000-000000000001.jsonl");
    const big = newest(mains.filter((path) => statSync(path).size > initialBytes * 2));
    const first = realLines(big, 0, initialBytes);
    writeFileSync(file, first.text);
    let offset = first.next;
    const found = await reader.discover([root]);
    const source: NativeSessionSource<string> | undefined = found.sources.find((entry) =>
        entry.filePath.endsWith(".jsonl")
    );

    if (!source) {
        throw new Error(`no scratch source for ${label}`);
    }

    await reader.readMetadata?.(source);
    const samples: number[] = [];

    for (let pass = 0; pass <= passes; pass++) {
        const more = realLines(big, offset, 64 * 1024);
        appendFileSync(file, more.text);
        offset = more.next;
        const started = cpuNow();
        await reader.readMetadata?.(source);
        const spent = cpuNow() - started;

        if (pass > 0) {
            samples.push(spent);
        }
    }

    return samples;
}

const metrics: Record<string, number> = {};
const claude: number[] = [];
const claudeAgents: number[] = [];
const all: number[] = [];

for (let pass = 0; pass <= passes; pass++) {
    const spentClaude = await tick("claude", liveMain);
    const spentAgents = await tick("claude-agents", liveAgent);

    if (pass > 0) {
        claude.push(spentClaude);
        claudeAgents.push(spentAgents);
    }
}

for (let pass = 0; pass <= Math.min(passes, 3); pass++) {
    const spent = await tick("all");

    if (pass > 0) {
        all.push(spent);
    }
}

metrics["tick.claudeMs"] = median(claude);
metrics["tick.claudeAgentsMs"] = median(claudeAgents);
metrics["tick.allMs"] = median(all);
metrics["metadata.grownSmallMs"] = median(await grownRead("small", 6 * 1024 * 1024));
metrics["metadata.grownLargeMs"] = median(await grownRead("large", 24 * 1024 * 1024));
metrics.liveMainBytes = statSync(liveMain).size;
process.stdout.write(`${SafeJSON.stringify(metrics, { strict: true })}\n`);
