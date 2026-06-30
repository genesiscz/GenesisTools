#!/usr/bin/env bun

import { out } from "@app/logger";
import { handleReadmeFlag } from "@app/utils/readme";
import pc from "picocolors";
import { streamCursorAgent } from "./lib/stream-agent";

handleReadmeFlag(import.meta.url);

// ─── CLI argument parsing ──────────────────────────────────────────────────

const args = process.argv.slice(2);

let mode = "ask";
let model: string | undefined;
let workspace = process.cwd();
let raw = false;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--mode" && args[i + 1]) {
        mode = args[++i];
    } else if (arg === "--model" && args[i + 1]) {
        model = args[++i];
    } else if (arg === "--workspace" && args[i + 1]) {
        workspace = args[++i];
    } else if (arg === "--raw") {
        raw = true;
    } else if (arg === "--help" || arg === "-h") {
        out.println(`Usage: tools cursor [options] <question>

Ask Cursor Agent a question about the codebase and stream the answer.

Arguments:
  question          The question to ask (all positional args joined)

Options:
  --mode <mode>     Cursor mode: ask (default), plan
  --model <model>   Model override (e.g. gpt-5, sonnet-4)
  --workspace <dir> Workspace directory (default: cwd)
  --raw             Print only the final answer text, no tool calls
  -h, --help        Show this help`);
        process.exit(0);
    } else if (!arg.startsWith("--")) {
        positional.push(arg);
    }
}

const question = positional.join(" ").trim();

if (!question) {
    out.error(pc.red("No question provided."));
    out.error(pc.dim('Usage: tools cursor "which service creates the reservation?"'));
    process.exit(1);
}

// ─── Spawn cursor agent ────────────────────────────────────────────────────

const cursorArgs = [
    "agent",
    `--mode=${mode}`,
    "--print",
    "--stream-partial-output",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    workspace,
];

if (model) {
    cursorArgs.push("--model", model);
}

cursorArgs.push(question);

const proc = Bun.spawn(["cursor", ...cursorArgs], {
    stdout: "pipe",
    stderr: "pipe",
});

let wroteText = false;

try {
    const exitCode = await streamCursorAgent(proc, {
        raw,
        onTextDelta: (text) => {
            process.stdout.write(text);
            wroteText = true;
        },
        onBlocks: (output) => {
            if (wroteText) {
                process.stdout.write("\n");
                wroteText = false;
            }
            process.stderr.write(`${output}\n`);
        },
    });

    if (wroteText) {
        process.stdout.write("\n");
    }

    process.exit(exitCode);
} catch (err) {
    proc.kill();
    await proc.exited;
    throw err;
}
