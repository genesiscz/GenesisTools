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

/** One line per file start or end; a line from another writer, or a cut-off last line, is skipped. */
export function parseWorkerLog(text: string): WorkerLogLine[] {
    const lines: WorkerLogLine[] = [];

    for (const raw of text.split("\n")) {
        if (!raw.trim()) {
            continue;
        }

        try {
            const value: unknown = SafeJSON.parse(raw, { strict: true });

            if (isWorkerLogLine(value)) {
                lines.push(value);
            }
        } catch {
            process.stderr.write(`test-worker-log: skipped an unreadable line: ${raw.slice(0, 80)}\n`);
        }
    }

    return lines;
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

    const lines = parseWorkerLog(readFileSync(path, "utf8"));
    const report = analyzeWorkerLog(lines);

    if (args.includes("--json")) {
        process.stdout.write(`${SafeJSON.stringify(report, { strict: true })}\n`);
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
}
