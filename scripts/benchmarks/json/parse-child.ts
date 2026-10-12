#!/usr/bin/env bun
import { FFIType } from "bun:ffi";
/**
 * One sample for `parse-arms.ts`: one way of parsing the same JSONL lines (the last 256 KB of every Claude transcript
 * changed in the last 24 hours), twice in this fresh process (cold, then warm), printed as
 * `{ coldCpuMs, warmCpuMs, check, lines }`. `check` counts the lines parsed and must agree between the arms.
 *
 *   bun scripts/benchmarks/json/parse-child.ts <arm>
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineNativeLibrary } from "@genesiscz/utils/bun/compiler";
import { fastWalk } from "@genesiscz/utils/fs/native/fast-walk";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { parse as commentJsonParse } from "comment-json";
import { PARSE_ARMS } from "./arms";

const SIMDJSON_PREFIX = "/opt/homebrew";
const arm = process.argv[2] ?? "";

if (!PARSE_ARMS.includes(arm as (typeof PARSE_ARMS)[number])) {
    throw new Error(`usage: parse-child.ts <${PARSE_ARMS.join("|")}>`);
}

/** The simdjson shim, built once by clang++ and cached, or null when simdjson is not installed (Homebrew). */
const simdjson = existsSync(join(SIMDJSON_PREFIX, "lib", "libsimdjson.dylib"))
    ? defineNativeLibrary({
          source: join(import.meta.dir, "simdjson-shim.cpp"),
          compiler: "clang",
          flags: [
              "-x",
              "c++",
              "-std=c++17",
              "-O3",
              `-I${SIMDJSON_PREFIX}/include`,
              `-L${SIMDJSON_PREFIX}/lib`,
              "-lsimdjson",
              "-lc++",
          ],
          symbols: {
              validate_lines: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
              pick_lines: {
                  args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
                  returns: FFIType.i32,
              },
          },
      })
    : null;

const since = Date.now() - 24 * 3_600_000;
const walked = await fastWalk({ roots: [join(homedir(), ".claude", "projects")], endsWith: [".jsonl"], maxDepth: 1 });
const lines: string[] = [];

for (const entry of walked.entries) {
    if (entry.kind === "file" && entry.mtimeMs >= since) {
        lines.push(...readLastLines(entry.path, { maxBytes: 256 * 1024 }).lines);
    }
}

const text = lines.join("\n");
// simdjson reads up to 64 bytes past a value; the padding keeps that inside the buffer.
const bytes = Buffer.from(`${text}\n${" ".repeat(128)}`);
const starts = new Int32Array(lines.length);
const ends = new Int32Array(lines.length);
let offset = 0;

for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += Buffer.byteLength(lines[i]);
    ends[i] = offset;
    offset += 1;
}

const picked = new Float64Array(lines.length * 16);

function eachLine(parseLine: (index: number) => unknown): number {
    let parsed = 0;

    for (let i = 0; i < lines.length; i++) {
        try {
            parseLine(i);
            parsed++;
        } catch {
            // A broken line counts as not parsed, in every arm alike.
        }
    }

    return parsed;
}

function once(): number {
    switch (arm) {
        case "jsonParse":
            // biome-ignore lint/style/noRestrictedGlobals: the native parser is the arm under test
            return eachLine((i) => JSON.parse(lines[i]));
        case "decodeJsonParse":
            // biome-ignore lint/style/noRestrictedGlobals: the native parser is the arm under test
            return eachLine((i) => JSON.parse(bytes.toString("utf8", starts[i], ends[i])));
        case "safeJson":
            return eachLine((i) => SafeJSON.parse(lines[i]));
        case "commentJson":
            return eachLine((i) => commentJsonParse(lines[i]));
        case "bunJsonl":
            return typeof Bun.JSONL?.parse === "function" ? Bun.JSONL.parse(text).length : -1;
        case "simdjsonFullParse":
            return simdjson ? simdjson().symbols.validate_lines(bytes, starts, ends, lines.length) : -1;
        default: {
            if (!simdjson) {
                return -1;
            }

            const count = simdjson().symbols.pick_lines(bytes, starts, ends, lines.length, picked);

            // The timestamps a listing reads, decoded from their byte offsets.
            for (let i = 0; i < lines.length; i++) {
                const at = i * 16;

                if ((picked[at] === 1 || picked[at] === 2) && picked[at + 4] >= 0) {
                    Date.parse(bytes.toString("latin1", picked[at + 4], picked[at + 4] + picked[at + 5]));
                }
            }

            return count;
        }
    }
}

function cpuSince(started: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
}

if (arm.startsWith("simdjson") && simdjson) {
    // The first build of the shim compiles simdjson's header (seconds); it must not land in the cold pass.
    simdjson();
}

const coldStarted = process.cpuUsage();
const check = once();
const coldCpuMs = cpuSince(coldStarted);
const warmStarted = process.cpuUsage();
once();
const warmCpuMs = cpuSince(warmStarted);

process.stdout.write(
    `${SafeJSON.stringify({ coldCpuMs, warmCpuMs, check, lines: lines.length, bytes: bytes.length }, { strict: true })}\n`
);
