#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { type MarkdownRenderOptions, renderMarkdownToCli } from "@genesiscz/utils/markdown/index.js";
import chokidar from "chokidar";
import { Command, Option } from "commander";
import { resolveColor } from "./lib/color";

interface MarkdownCLIOptions {
    watch?: boolean;
    width?: number;
    theme?: string;
    color?: boolean;
    tableEngine?: string;
}

const program = new Command();

program
    .name("markdown-cli")
    .description("Render markdown to beautiful CLI output")
    .argument("[file]", "Markdown file to render (or pipe via stdin)")
    .option("-w, --watch", "Watch file for changes and re-render")
    .option("--width <n>", "Max output width in columns", parseInt)
    .addOption(
        new Option("--theme <name>", "Color theme: dark, light, minimal")
            .choices(["dark", "light", "minimal"])
            .default("dark")
    )
    .addOption(
        new Option(
            "--table-engine <name>",
            "Table renderer: auto (box, cards when too narrow), ascii (width-fitted box), cards (stacked label/value), cli-table3 (port-style box), plain (padded, no borders), html (cli-html's own)"
        )
            .choices(["auto", "ascii", "cards", "cli-table3", "plain", "html"])
            .default("auto")
    )
    .option("--no-color", "Strip ANSI color codes from output")
    .option("--color", "Force ANSI colour even when stdout is not a TTY (piping to `less -R`)")
    .action((file: string | undefined, opts: MarkdownCLIOptions | undefined, command: Command) => {
        const renderOpts: MarkdownRenderOptions = {
            width: opts?.width && !Number.isNaN(opts.width) ? opts.width : undefined,
            theme: (opts?.theme as MarkdownRenderOptions["theme"]) || "dark",
            // Colour follows the TTY unless the user says otherwise. It used to
            // default to on unconditionally, so piping to a file or another
            // program embedded raw escapes. `--color` keeps the piped-with-colour
            // case (`… | less -R`) reachable.
            //
            // Boolean() matters: process.stdout.isTTY is `undefined` when stdout
            // is a pipe, not false, and the renderer strips only on an exact
            // `color === false`.
            color: resolveColor(opts?.color, command.getOptionValueSource("color"), Boolean(process.stdout.isTTY)),
            tableEngine: (opts?.tableEngine as MarkdownRenderOptions["tableEngine"]) || "auto",
        };

        if (!process.stdin.isTTY) {
            const markdown = readFileSync(0, "utf-8");
            out.println(renderMarkdownToCli(markdown, renderOpts));
            return;
        }

        if (!file) {
            program.help();
            return;
        }

        const filePath = resolve(file);
        if (!existsSync(filePath)) {
            out.error(`File not found: ${filePath}`);
            process.exit(1);
        }

        function renderFile() {
            const markdown = readFileSync(filePath, "utf-8");
            if (opts?.watch) {
                process.stdout.write("\x1b[2J\x1b[H"); // Clear screen
            }
            out.println(renderMarkdownToCli(markdown, renderOpts));
            if (opts?.watch) {
                out.println(`\n--- Watching ${filePath} for changes (Ctrl+C to stop) ---\n`);
            }
        }

        renderFile();

        if (opts?.watch) {
            const watcher = chokidar.watch(filePath, { ignoreInitial: true });
            watcher.on("change", () => {
                renderFile();
            });
        }
    });

// Guarded so importing this module does not run the CLI. src/markdown-cli/lib/
// holds the testable pieces; an unguarded entrypoint is what made the full test
// suite hang indefinitely on transcribe (see PR #335).
if (import.meta.main) {
    await runTool(program, { tool: "markdown-cli" });
}
