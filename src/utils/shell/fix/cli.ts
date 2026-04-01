#!/usr/bin/env bun
/**
 * CLI wrapper for fixShellCommand.
 *
 * Reads stdin, fixes the shell command, writes to stdout.
 * Usage: pbpaste | bun src/utils/shell/fix/cli.ts [--no-pretty]
 */

import { preProcess, prettifyCommand } from "./preprocess.js";

const noPretty = process.argv.includes("--no-pretty");
const input = await Bun.stdin.text();

if (!input.trim()) {
    process.exit(1);
}

try {
    let result = preProcess(input).text;

    if (!noPretty) {
        result = prettifyCommand(result);
    }

    if (!result) {
        process.exit(1);
    }

    process.stdout.write(result);
} catch {
    // Best-effort fallback
    const fallback = input.replace(/\r/g, "").trim();

    if (fallback) {
        process.stdout.write(fallback);
    } else {
        process.exit(1);
    }
}
