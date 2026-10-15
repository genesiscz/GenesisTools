#!/usr/bin/env bun

import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import pc from "picocolors";
import { parseCursorArgs } from "./lib/args";
import { streamCursorAgent } from "./lib/stream-agent";

handleReadmeFlag(import.meta.url);

// ─── CLI argument parsing ──────────────────────────────────────────────────

const parsed = parseCursorArgs(process.argv.slice(2), process.cwd());

if (!parsed.ok) {
    out.error(pc.red(parsed.message));
    out.error(pc.dim(`Run ${toolCommand("cursor")} --help for the options.`));
    process.exit(1);
}

const { mode, model, workspace, raw, help, question } = parsed.args;

if (help) {
    out.println(`Usage: ${toolCommand("cursor")} [options] <question>

Ask Cursor Agent a question about the codebase and stream the answer.

Arguments:
  question          The question to ask (all positional args joined)

Options:
  --mode <mode>     Cursor mode: ask (default), plan
  --model <model>   Model override (e.g. gpt-5, sonnet-4)
  --workspace <dir> Workspace directory (default: cwd)
  --raw             Print only the final answer text, no tool calls
  -h, --help        Show this help

Each option also takes its value as --option=value.`);
    process.exit(0);
}

if (!question) {
    out.error(pc.red("No question provided."));
    out.error(pc.dim(`Usage: ${toolCommand("cursor")} "which service creates the reservation?"`));
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
        onStderr: (text) => process.stderr.write(`${text}\n`),
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
