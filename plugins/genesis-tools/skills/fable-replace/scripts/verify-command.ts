/**
 * fable-replace — RUNNING THE VERIFY COMMAND, the check a sweep runs after it wrote.
 *
 * The command is captured, never inherited. That lets the CLI trim what the reader sees
 * (a green test run is a five-line summary, not 300 lines), save the whole output beside
 * the backup, and tell three outcomes apart: exit 0 is a pass; a real non-zero exit is a
 * fail; no exit status at all (a signal, the timeout, more output than the buffer holds)
 * is "unknown", which means the sweep is on disk and the verdict could not be measured.
 * That is neither a pass nor a test failure, and it is never reported as one.
 *
 * A red verify never rolls the sweep back. The reasons live in sweep-many-files.ts.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringifyJson } from "./json";
import type { RunVerifyParams, VerifyResult } from "./types";

/** A fixed backstop, not a flag: one more flag is one more thing to get wrong. */
export const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
/** Well above any test runner's output. The 1 MB default turned a green suite into ENOBUFS. */
const VERIFY_MAX_BUFFER = 64 * 1024 * 1024;
const PASS_TAIL_LINES = 5;
const FAIL_HEAD_LINES = 40;
const FAIL_TAIL_LINES = 60;
/** One line can be a 50 KB JSON blob; the reader gets its start. */
const MAX_LINE_CHARS = 500;
export const VERIFY_OUTPUT_FILE = "verify-output.txt";

const clip = (line: string): string =>
    line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}… (+${line.length - MAX_LINE_CHARS} chars)`;

/** Head and tail around an omitted-lines marker; the whole output when it is short enough. */
export const trimOutput = ({ lines, head, tail }: { lines: string[]; head: number; tail: number }): string[] => {
    if (lines.length <= head + tail) {
        return lines.map(clip);
    }

    const omitted = lines.length - head - tail;
    return [...lines.slice(0, head).map(clip), `… ${omitted} line(s) omitted …`, ...lines.slice(-tail).map(clip)];
};

const REFUSALS = {
    pipe: "contains a pipe.\nA pipeline reports the LAST command's exit code, so a failing test reads as PASS\n(/bin/sh), and `set -o pipefail` reports FAIL when `head` closes the pipe early.\nBoth lie. Drop the pipe: this CLI already trims the output for you.\nIf you truly need one, own the exit code yourself:\n  --verify \"bash -c 'set -o pipefail; <your pipeline>'\"",
    chain: "contains a `;` chain. Only the LAST command's exit code is reported, so `a; b` turns a red `a` into a green verify. Chain with `&&`, or run one command.",
    newline:
        "spans more than one line. Only the LAST line's exit code is reported, so an earlier red line reads as PASS. Chain with `&&`, or run one command.",
    background:
        "contains a background `&`. A backgrounded command returns 0 immediately, so the check never reaches a verdict. Run it in the foreground.",
};

/**
 * Refuse only the shell operators that can hide a non-zero exit status: a pipe, a `;`
 * chain, a newline, a background `&`. Redirects, `$( )`, backticks and `VAR=1` prefixes
 * cannot change the status of the command whose status is read, so they pass. `&&`
 * and `||` pass too. Anything inside single or double quotes is opaque, which is the
 * escape hatch: `bash -c 'set -o pipefail; …'` names the risk in the command itself.
 *
 * A quote-state scanner, not a shell parser: a pipe inside `$( )` is refused as well.
 * That false positive is cheaper than a parser. Measured on this machine: `exit 7 | cat`
 * is status 0 under /bin/sh, and `bash -o pipefail` turns `rg | head` into a false FAIL.
 */
export const checkVerifyCommand = (command: string): { refusal?: string; warning?: string } => {
    let single = false;
    let double = false;
    let unquoted = "";
    let found: keyof typeof REFUSALS | undefined;
    for (let i = 0; i < command.length && found === undefined; i += 1) {
        const ch = command[i];
        const next = command[i + 1];
        if (single) {
            if (ch === "'") {
                single = false;
            }

            continue;
        }

        if (ch === "\\") {
            i += 1;
            continue;
        }

        if (double) {
            if (ch === '"') {
                double = false;
            }

            continue;
        }

        if (ch === "'") {
            single = true;
            continue;
        }

        if (ch === '"') {
            double = true;
            continue;
        }

        unquoted += ch;
        if (ch === "|") {
            if (next === "|") {
                unquoted += next;
                i += 1;
                continue;
            }

            found = "pipe";
        } else if (ch === ";") {
            found = "chain";
        } else if (ch === "\n") {
            found = "newline";
        } else if (ch === "&") {
            if (next === "&" || next === ">") {
                unquoted += next;
                i += 1;
                continue;
            }

            const prev = command[i - 1];
            if (prev === ">" || prev === "<") {
                continue;
            }

            found = "background";
        }
    }

    if (found !== undefined) {
        return { refusal: `--verify ${stringifyJson(command)} ${REFUSALS[found]}\nNothing was written.` };
    }

    if (unquoted.includes("/dev/null")) {
        return {
            warning: `--verify ${stringifyJson(command)} sends output to /dev/null: the check still runs, but the lines needed to fix forward are discarded. Drop the redirect; the CLI trims the output itself.`,
        };
    }

    return {};
};

/** Why a verify has no exit status, in the reader's words. */
export const verifyUnknownReason = (verify: VerifyResult): string => {
    if (verify.timedOut) {
        return `timed out after ${Math.round(verify.ms / 1000)} s`;
    }

    if (verify.buffered) {
        return "its output exceeded the 64 MB capture buffer";
    }

    if (verify.signal !== null) {
        return `killed by ${verify.signal}`;
    }

    return verify.error ?? "no exit status";
};

/**
 * Run the verify command through the shell with both streams captured and stdin closed
 * (the CLI already consumed its own stdin for the spec, and an interactive prompt inside
 * a check would hang the sweep). Returns the verdict plus the lines to show. It prints
 * nothing itself, so the caller owns the order of the narration.
 */
export const runVerifyCommand = ({
    command,
    cwd,
    backupDir,
    timeoutMs = VERIFY_TIMEOUT_MS,
}: RunVerifyParams): VerifyResult => {
    const started = Date.now();
    const child = spawnSync(command, {
        shell: true,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: VERIFY_MAX_BUFFER,
        timeout: timeoutMs,
    });
    const ms = Date.now() - started;
    // Separate pipes cannot interleave the two streams. stdout first, then stderr, which
    // keeps a test runner's summary (stderr for `bun test`) at the tail where a reader looks.
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    const errorCode = (child.error as { code?: string } | undefined)?.code;
    const status: VerifyResult["status"] = child.status === 0 ? "pass" : child.status === null ? "unknown" : "fail";

    let outputFile: string | undefined;
    if (backupDir !== undefined) {
        try {
            fs.mkdirSync(backupDir, { recursive: true });
            outputFile = path.join(backupDir, VERIFY_OUTPUT_FILE);
            fs.writeFileSync(outputFile, output);
        } catch (err) {
            console.error(`could not save the verify output: ${String(err)}`);
            outputFile = undefined;
        }
    }

    const lines = output.length === 0 ? [] : output.replace(/\n$/, "").split("\n");
    let shown: string[];
    if (status === "pass") {
        shown = lines.slice(-PASS_TAIL_LINES).map(clip);
        if (lines.length > PASS_TAIL_LINES) {
            const where = outputFile === undefined ? "" : ` (full output: ${outputFile})`;
            shown.unshift(`… ${lines.length - PASS_TAIL_LINES} earlier line(s) suppressed${where}`);
        }
    } else {
        shown = trimOutput({ lines, head: FAIL_HEAD_LINES, tail: FAIL_TAIL_LINES });
    }

    return {
        command,
        status,
        exitCode: child.status,
        signal: child.signal ?? null,
        timedOut: errorCode === "ETIMEDOUT",
        buffered: errorCode === "ENOBUFS",
        ms,
        outputChars: output.length,
        shown,
        outputFile,
        error: child.error === undefined ? undefined : String(child.error.message ?? child.error),
    };
};
