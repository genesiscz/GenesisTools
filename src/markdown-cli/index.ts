#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import chokidar from "chokidar";
import { renderMarkdownToCli, type MarkdownRenderOptions } from "../utils/markdown/index.js";

const program = new Command();

program
    .name("markdown-cli")
    .description("Render markdown to beautiful CLI output")
    .argument("[file]", "Markdown file to render (or pipe via stdin)")
    .option("-w, --watch", "Watch file for changes and re-render")
    .option("--width <n>", "Max output width in columns", parseInt)
    .option("--theme <name>", "Color theme: dark, light, minimal", "dark")
    .option("--no-color", "Strip ANSI color codes from output")
    .action((file?: string, opts?: { watch?: boolean; width?: number; theme?: string; color?: boolean }) => {
        const renderOpts: MarkdownRenderOptions = {
            width: opts?.width && !isNaN(opts.width) ? opts.width : undefined,
            theme: (opts?.theme as MarkdownRenderOptions["theme"]) || "dark",
            color: opts?.color !== false,
        };

        if (!process.stdin.isTTY) {
            const markdown = readFileSync(0, "utf-8");
            console.log(renderMarkdownToCli(markdown, renderOpts));
            return;
        }

        if (!file) {
            program.help();
            return;
        }

        const filePath = resolve(file);
        if (!existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }

        function renderFile() {
            const markdown = readFileSync(filePath, "utf-8");
            if (opts?.watch) {
                process.stdout.write("\x1b[2J\x1b[H"); // Clear screen
            }
            console.log(renderMarkdownToCli(markdown, renderOpts));
            if (opts?.watch) {
                console.log(`\n--- Watching ${filePath} for changes (Ctrl+C to stop) ---\n`);
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

program.parse();
