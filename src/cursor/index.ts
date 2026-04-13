#!/usr/bin/env bun

import { CursorStreamAdapter } from "@app/utils/agents/adapters/cursor";
import { TerminalRenderer } from "@app/utils/agents/renderers/TerminalRenderer";
import { handleReadmeFlag } from "@app/utils/readme";
import pc from "picocolors";

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
        console.log(`Usage: tools cursor [options] <question>

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
    console.error(pc.red("No question provided."));
    console.error(pc.dim("Usage: tools cursor \"which service creates the reservation?\""));
    process.exit(1);
}

// ─── Spawn cursor agent ────────────────────────────────────────────────────

const cursorArgs = [
    "agent",
    `--mode=${mode}`,
    "--print",
    "--stream-partial-output",
    "--output-format", "stream-json",
    "--trust",
    "--workspace", workspace,
];

if (model) {
    cursorArgs.push("--model", model);
}

cursorArgs.push(question);

const proc = Bun.spawn(["cursor", ...cursorArgs], {
    stdout: "pipe",
    stderr: "pipe",
});

// ─── Stream processing ─────────────────────────────────────────────────────

const adapter = new CursorStreamAdapter();
const renderer = new TerminalRenderer({
    colors: !!(process.stderr as NodeJS.WriteStream).isTTY,
});

const decoder = new TextDecoder();
let buffer = "";
let wroteText = false;

const reader = proc.stdout.getReader();

try {
    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;

        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);

            const parsed = adapter.parseLine(line);

            // Text delta — stream to stdout
            if (parsed.textDelta) {
                process.stdout.write(parsed.textDelta);
                wroteText = true;
            }

            // Blocks (tool calls, results, metadata) — render to stderr
            if (parsed.blocks.length > 0 && !raw) {
                // Ensure fresh line before tool output
                if (wroteText) {
                    process.stdout.write("\n");
                    wroteText = false;
                }

                const rendered = renderer.render(parsed.blocks);
                const output = rendered.join("\n");

                if (output.trim()) {
                    process.stderr.write(`${output}\n`);
                }
            }

            if (parsed.done) {
                break;
            }
        }
    }
} finally {
    reader.releaseLock();
}

// Trailing newline
if (wroteText) {
    process.stdout.write("\n");
}

// Forward stderr from cursor (errors, warnings)
const stderrText = await new Response(proc.stderr).text();

if (stderrText.trim()) {
    process.stderr.write(pc.dim(stderrText));
}

const exitCode = await proc.exited;
process.exit(exitCode);
