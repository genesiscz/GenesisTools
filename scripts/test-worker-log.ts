#!/usr/bin/env bun
/**
 * Reads the opt-in test-worker log (src/utils/bun/preload-test-worker-log.ts) and names the test files
 * that LEFT child processes behind in their worker, and the files that STARTED with someone else's.
 *
 *   GENESIS_TOOLS_TEST_WORKER_LOG=1 bun run test          # writes test-worker-log.jsonl
 *   bun scripts/test-worker-log.ts [test-worker-log.jsonl] [--json]
 *
 * A file's leftovers are the worker's children alive at its end that were not alive at its start. Bun
 * prints "killed N dangling process" for those at a LATER file, which is why the CI log alone points at
 * the wrong file.
 */
import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";

export interface WorkerLogChild {
    pid: number;
    ppid: number;
    command: string;
}

export interface WorkerLogLine {
    event: "start" | "end";
    at: string;
    worker: string;
    pid: number;
    file: string;
    children: WorkerLogChild[];
}

export interface Leftover {
    file: string;
    worker: string;
    workerPid: number;
    processes: WorkerLogChild[];
}

export interface Inherited {
    file: string;
    worker: string;
    workerPid: number;
    processes: Array<WorkerLogChild & { leftBy: string | null }>;
}

function isWorkerLogLine(value: unknown): value is WorkerLogLine {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const line = value as Record<string, unknown>;
    return (
        (line.event === "start" || line.event === "end") &&
        typeof line.at === "string" &&
        typeof line.pid === "number" &&
        typeof line.file === "string" &&
        Array.isArray(line.children)
    );
}

/** A test still running after 15 s (`preload-test-worker-log.ts`): its worker's threads and children then. */
export interface WorkerStallLine {
    event: "stall";
    at: string;
    worker: string;
    pid: number;
    file: string;
    ms: number;
    threads: Array<{ tid: number; name: string; state: string; wchan: string }>;
    children: Array<{ pid: number; state: string; command: string }>;
}

function isWorkerStallLine(value: unknown): value is WorkerStallLine {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const line = value as Record<string, unknown>;
    return (
        line.event === "stall" &&
        typeof line.file === "string" &&
        typeof line.ms === "number" &&
        Array.isArray(line.threads) &&
        Array.isArray(line.children)
    );
}

function parseLines<T>(text: string, accept: (value: unknown) => value is T, warn: boolean): T[] {
    const lines: T[] = [];

    for (const raw of text.split("\n")) {
        if (!raw.trim()) {
            continue;
        }

        try {
            const value: unknown = SafeJSON.parse(raw, { strict: true });

            if (accept(value)) {
                lines.push(value);
            }
        } catch {
            if (warn) {
                process.stderr.write(`test-worker-log: skipped an unreadable line: ${raw.slice(0, 80)}\n`);
            }
        }
    }

    return lines;
}

/** One line per file start or end; a line from another writer, or a cut-off last line, is skipped. */
export function parseWorkerLog(text: string): WorkerLogLine[] {
    return parseLines(text, isWorkerLogLine, true);
}

/** The `stall` lines; parseWorkerLog already reported any unreadable line. */
export function parseWorkerStalls(text: string): WorkerStallLine[] {
    return parseLines(text, isWorkerStallLine, false);
}

/** "S 12, D 1 (wait_log_commit)": how many threads sit in each state, with the wait of any not merely sleeping. */
export function describeStallThreads(threads: WorkerStallLine["threads"]): string {
    const counts = new Map<string, number>();
    const waits = new Set<string>();

    for (const thread of threads) {
        counts.set(thread.state, (counts.get(thread.state) ?? 0) + 1);

        if (thread.state !== "S" && thread.wchan !== "0" && thread.wchan !== "?") {
            waits.add(thread.wchan);
        }
    }

    const summary = [...counts].map(([state, count]) => `${state} ${count}`).join(", ");
    return waits.size > 0 ? `${summary} (${[...waits].join(", ")})` : summary;
}

/** Walks each worker's files in time order and attributes every child process to the file that left it. */
export function analyzeWorkerLog(lines: readonly WorkerLogLine[]): { leftovers: Leftover[]; inherited: Inherited[] } {
    const byWorker = new Map<number, WorkerLogLine[]>();

    for (const line of lines) {
        byWorker.set(line.pid, [...(byWorker.get(line.pid) ?? []), line]);
    }

    const leftovers: Leftover[] = [];
    const inherited: Inherited[] = [];

    for (const [workerPid, events] of byWorker) {
        const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
        const origin = new Map<number, string>();
        const startOf = new Map<string, Set<number>>();

        for (const event of ordered) {
            const pids = new Set(event.children.map((child) => child.pid));

            if (event.event === "start") {
                startOf.set(event.file, pids);

                if (event.children.length > 0) {
                    inherited.push({
                        file: event.file,
                        worker: event.worker,
                        workerPid,
                        processes: event.children.map((child) => ({ ...child, leftBy: origin.get(child.pid) ?? null })),
                    });
                }

                continue;
            }

            const before = startOf.get(event.file) ?? new Set<number>();
            const left = event.children.filter((child) => !before.has(child.pid));

            for (const child of left) {
                origin.set(child.pid, event.file);
            }

            if (left.length > 0) {
                leftovers.push({ file: event.file, worker: event.worker, workerPid, processes: left });
            }
        }
    }

    leftovers.sort((a, b) => b.processes.length - a.processes.length);
    return { leftovers, inherited };
}

function relative(file: string): string {
    const cwd = `${process.cwd()}/`;
    return file.startsWith(cwd) ? file.slice(cwd.length) : file;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const path = args.find((arg) => !arg.startsWith("--")) ?? "test-worker-log.jsonl";

    if (!existsSync(path)) {
        process.stderr.write(
            `test-worker-log: ${path} does not exist. Record one with GENESIS_TOOLS_TEST_WORKER_LOG=1 bun run test\n`
        );
        process.exit(2);
    }

    const text = readFileSync(path, "utf8");
    const lines = parseWorkerLog(text);
    const stalls = parseWorkerStalls(text);
    const report = analyzeWorkerLog(lines);

    if (args.includes("--json")) {
        process.stdout.write(`${SafeJSON.stringify({ ...report, stalls }, { strict: true })}\n`);
        process.exit(0);
    }

    const files = new Set(lines.map((line) => line.file)).size;
    const workers = new Set(lines.map((line) => line.pid)).size;
    process.stdout.write(`${files} test files across ${workers} worker process(es)\n\n`);

    if (report.leftovers.length === 0) {
        process.stdout.write("No file left a child process behind.\n");
    } else {
        process.stdout.write("Files that left child processes behind (alive at the file's end, not at its start):\n");

        for (const item of report.leftovers) {
            process.stdout.write(`  ${item.processes.length}  ${relative(item.file)}  (worker ${item.worker})\n`);

            for (const child of item.processes.slice(0, 5)) {
                process.stdout.write(`       pid ${child.pid}: ${child.command}\n`);
            }
        }
    }

    if (report.inherited.length > 0) {
        process.stdout.write("\nFiles that started with another file's processes still alive:\n");

        for (const item of report.inherited) {
            const sources = [...new Set(item.processes.map((child) => (child.leftBy ? relative(child.leftBy) : "?")))];
            process.stdout.write(
                `  ${relative(item.file)}: ${item.processes.length} from ${sources.join(", ")} (worker ${item.worker})\n`
            );
        }
    }

    if (stalls.length > 0) {
        process.stdout.write("\nTests still running after 15 s (threads by state, then children):\n");

        for (const stall of stalls) {
            const threads = describeStallThreads(stall.threads) || "no /proc";
            process.stdout.write(`  ${relative(stall.file)} (worker ${stall.worker}, ${stall.ms} ms): ${threads}\n`);

            for (const child of stall.children.slice(0, 8)) {
                process.stdout.write(`       pid ${child.pid} ${child.state}: ${child.command || "?"}\n`);
            }
        }
    }
}
