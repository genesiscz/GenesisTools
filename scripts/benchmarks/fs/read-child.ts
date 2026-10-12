#!/usr/bin/env bun
import { FFIType } from "bun:ffi";
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * One sample for `read-primitives.ts`: one way of doing one file job over real session files, twice in this fresh
 * process (cold, then warm), printed as `{ coldCpuMs, warmCpuMs, check }`. `check` must agree between the arms of a
 * job, so every arm does the same work.
 *
 * Jobs:
 *   - `head`: the complete lines in the first 64 KB of every Codex rollout (what finding a rollout's header needs).
 *   - `tail`: the complete lines in the last 64 KB of every Claude transcript changed in the last 24 hours (what the
 *     session list's token usage needs).
 *   - `stat`: size, mtime and inode of every session file the listing knows (what a freshness check needs).
 *
 *   bun scripts/benchmarks/fs/read-child.ts <job> <arm>
 */
import { extractTailUsageUncached } from "@app/claude/lib/usage/session-rows";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";
import { fastWalk } from "@genesiscz/utils/fs/native/fast-walk";
import { readFirstLines, readLastLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { READ_ARMS } from "./walk-trees";

const BYTES = 64 * 1024;
const [job, arm] = process.argv.slice(2) as [keyof typeof READ_ARMS, string];

if (!READ_ARMS[job]?.includes(arm as never)) {
    throw new Error(`usage: read-child.ts <${Object.keys(READ_ARMS).join("|")}> <arm>`);
}

const libSystem = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: {
        open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        pread: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
        lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
        stat: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    },
});
const O_CLOEXEC = 0x1000000;
const SEEK_END = 2;

async function files(): Promise<string[]> {
    if (job === "head") {
        const walked = await fastWalk({ roots: [join(homedir(), ".codex", "sessions")], endsWith: [".jsonl"] });
        return walked.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    }

    if (job === "tail") {
        const since = Date.now() - 24 * 3_600_000;
        const walked = await fastWalk({
            roots: [join(homedir(), ".claude", "projects")],
            endsWith: [".jsonl"],
            maxDepth: 1,
        });
        return walked.entries
            .filter((entry) => entry.kind === "file" && entry.mtimeMs >= since)
            .map((entry) => entry.path);
    }

    const walked = await Promise.all(
        [
            { root: join(homedir(), ".claude", "projects"), names: [], endsWith: [".jsonl"], maxDepth: 1 },
            { root: join(homedir(), ".grok", "sessions"), names: ["chat_history.jsonl"], endsWith: [], maxDepth: 2 },
            { root: join(homedir(), ".codex", "sessions"), names: [], endsWith: [".jsonl"], maxDepth: undefined },
        ].map((tree) =>
            fastWalk({ roots: [tree.root], names: tree.names, endsWith: tree.endsWith, maxDepth: tree.maxDepth })
        )
    );
    return walked.flatMap((result) =>
        result.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)
    );
}

/** Complete lines of a chunk: the last line is dropped unless the chunk reached the end of the file. */
function headLines(text: string, complete: boolean): number {
    const lines = text.split("\n");

    if (!complete) {
        lines.pop();
    }

    return lines.filter((line) => line.trim() !== "").length;
}

/** Complete lines of a tail chunk: the first line is dropped unless it starts the file or follows a newline. */
function tailLines(text: string, startsLine: boolean): number {
    const lines = text.split("\n");

    if (!startsLine) {
        lines.shift();
    }

    return lines.filter((line) => line.trim() !== "").length;
}

const buffer = Buffer.alloc(BYTES + 1);
const statBuffer = new Uint8Array(144);
const statWords = new Uint32Array(statBuffer.buffer);

async function head(path: string): Promise<number> {
    switch (arm) {
        case "readFirstLines":
            return readFirstLines(path, { maxBytes: BYTES }).lines.length;
        case "readFirstLinesFfi":
            return readFirstLines(path, { maxBytes: BYTES, method: "ffi" }).lines.length;
        case "stream": {
            const reader = Bun.file(path).stream().getReader();
            const chunk = await reader.read();
            await reader.cancel();
            const bytes = chunk.value ?? new Uint8Array(0);
            const text = new TextDecoder().decode(bytes.subarray(0, BYTES));
            return headLines(text, bytes.length < BYTES);
        }
        case "slice": {
            const file = Bun.file(path);
            const text = await file.slice(0, BYTES).text();
            return headLines(text, Buffer.byteLength(text) < BYTES);
        }
        case "promises": {
            const handle = await open(path, "r");
            try {
                const { bytesRead } = await handle.read(buffer, 0, BYTES, 0);
                return headLines(buffer.toString("utf8", 0, bytesRead), bytesRead < BYTES);
            } finally {
                await handle.close();
            }
        }
        case "sync": {
            const fd = openSync(path, "r");
            try {
                const bytesRead = readSync(fd, buffer, 0, BYTES, 0);
                return headLines(buffer.toString("utf8", 0, bytesRead), bytesRead < BYTES);
            } finally {
                closeSync(fd);
            }
        }
        case "ffi": {
            const calls = libSystem();

            if (!calls) {
                throw new Error("libSystem unavailable");
            }

            const fd = calls.open(Buffer.from(`${path}\0`), O_CLOEXEC);
            const bytesRead = Number(calls.pread(fd, buffer, BYTES, 0));
            calls.close(fd);
            return headLines(buffer.toString("utf8", 0, bytesRead), bytesRead < BYTES);
        }
        default: {
            const bytes = await Bun.file(path).bytes();
            return headLines(Buffer.from(bytes.subarray(0, BYTES)).toString("utf8"), bytes.length <= BYTES);
        }
    }
}

/** What the tail cache saves: every line of the window parsed, as `parseTailLines` does at most. */
function parseAll(lines: string[]): number {
    let parsed = 0;

    for (const line of lines) {
        try {
            SafeJSON.parse(line, { strict: true });
            parsed++;
        } catch {
            // A cut or broken line is skipped, as the listing skips it.
        }
    }

    return parsed;
}

async function tail(path: string): Promise<number> {
    switch (arm) {
        case "readLastLines":
            return readLastLines(path, { maxBytes: BYTES }).lines.length;
        case "readLastLinesFfi":
            return readLastLines(path, { maxBytes: BYTES, method: "ffi" }).lines.length;
        case "tailUsage":
            return (await extractTailUsageUncached(path)).usage.model ? 1 : 0;
        case "readLastLinesParse":
            return parseAll(readLastLines(path, { maxBytes: BYTES }).lines);
        case "sliceTwice": {
            const file = Bun.file(path);
            const size = file.size;
            const start = Math.max(0, size - BYTES);
            const text = await file.slice(start, size).text();
            const previous = start > 0 ? await file.slice(start - 1, start).text() : "\n";
            return tailLines(text, previous === "\n");
        }
        case "slice": {
            const file = Bun.file(path);
            const size = file.size;
            const start = Math.max(0, size - BYTES - 1);
            const text = await file.slice(start, size).text();
            return start === 0 ? tailLines(text, true) : tailLines(text.slice(1), text.startsWith("\n"));
        }
        case "sync": {
            const fd = openSync(path, "r");
            try {
                const size = fstatSync(fd).size;
                const start = Math.max(0, size - BYTES - 1);
                const bytesRead = readSync(fd, buffer, 0, size - start, start);
                const text = buffer.toString("utf8", 0, bytesRead);
                return start === 0 ? tailLines(text, true) : tailLines(text.slice(1), text.startsWith("\n"));
            } finally {
                closeSync(fd);
            }
        }
        default: {
            const calls = libSystem();

            if (!calls) {
                throw new Error("libSystem unavailable");
            }

            const fd = calls.open(Buffer.from(`${path}\0`), O_CLOEXEC);
            const size = Number(calls.lseek(fd, 0, SEEK_END));
            const start = Math.max(0, size - BYTES - 1);
            const bytesRead = Number(calls.pread(fd, buffer, size - start, start));
            calls.close(fd);
            const text = buffer.toString("utf8", 0, bytesRead);
            return start === 0 ? tailLines(text, true) : tailLines(text.slice(1), text.startsWith("\n"));
        }
    }
}

async function statAll(paths: string[]): Promise<number> {
    let total = 0;

    if (arm === "promises") {
        const stats = await Promise.all(paths.map((path) => stat(path)));
        return stats.reduce((sum, status) => sum + (status.size > 0 ? 1 : 0), 0);
    }

    if (arm === "bunFile") {
        const stats = await Promise.all(paths.map((path) => Bun.file(path).stat()));
        return stats.reduce((sum, status) => sum + (status.size > 0 ? 1 : 0), 0);
    }

    for (const path of paths) {
        if (arm === "statSync") {
            total += statSync(path).size > 0 ? 1 : 0;
        } else if (arm === "lstatSync") {
            total += lstatSync(path).size > 0 ? 1 : 0;
        } else {
            const calls = libSystem();

            if (calls?.stat(Buffer.from(`${path}\0`), statBuffer) !== 0) {
                continue;
            }

            // struct stat on arm64: st_mtimespec at byte 48 (seconds, then nanoseconds at 56), st_size at 96.
            const size = statWords[25] * 2 ** 32 + statWords[24];
            const mtimeMs = (statWords[13] * 2 ** 32 + statWords[12]) * 1000 + statWords[14] / 1e6;
            total += size > 0 && mtimeMs > 0 ? 1 : 0;
        }
    }

    return total;
}

async function once(paths: string[]): Promise<number> {
    if (job === "stat") {
        return statAll(paths);
    }

    let lines = 0;

    for (const path of paths) {
        lines += job === "head" ? await head(path) : await tail(path);
    }

    return lines;
}

function cpuSince(started: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
}

const paths = await files();
const coldStarted = process.cpuUsage();
const check = await once(paths);
const coldCpuMs = cpuSince(coldStarted);
const warmStarted = process.cpuUsage();
await once(paths);
const warmCpuMs = cpuSince(warmStarted);

process.stdout.write(`${SafeJSON.stringify({ coldCpuMs, warmCpuMs, check, files: paths.length }, { strict: true })}\n`);
