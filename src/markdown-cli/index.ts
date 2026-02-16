#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
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
            width: opts?.width,
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
        }

        renderFile();

        if (opts?.watch) {
            console.log(`\n--- Watching ${filePath} for changes (Ctrl+C to stop) ---\n`);
            const watcher = chokidar.watch(filePath, { ignoreInitial: true });
            watcher.on("change", () => {
                renderFile();
            });
        }
    });

program
    .command("demo")
    .description("Browse and preview markdown rendering templates")
    .option("-l, --list", "List available templates")
    .option("-a, --all", "Render all templates in sequence")
    .action(async (opts: { list?: boolean; all?: boolean }) => {
        const templatesDir = join(import.meta.dirname, "templates");
        const templates = readdirSync(templatesDir)
            .filter(f => f.endsWith(".md"))
            .map(f => {
                const content = readFileSync(join(templatesDir, f), "utf-8");
                const firstLine = content.split("\n").find(l => l.startsWith("# "));
                return {
                    file: f,
                    name: basename(f, ".md"),
                    title: firstLine?.replace(/^#\s+/, "") || basename(f, ".md"),
                    path: join(templatesDir, f),
                };
            });

        if (opts.list) {
            console.log(pc.bold("\nAvailable templates:\n"));
            for (const t of templates) {
                console.log(`  ${pc.cyan(t.name.padEnd(16))} ${pc.dim(t.title)}`);
            }
            console.log();
            return;
        }

        if (opts.all) {
            for (const t of templates) {
                const content = readFileSync(t.path, "utf-8");
                console.log(pc.dim(`\n${"─".repeat(60)}`));
                console.log(pc.bold(pc.cyan(`  Template: ${t.name}`)));
                console.log(pc.dim(`${"─".repeat(60)}\n`));
                console.log(renderMarkdownToCli(content));
            }
            return;
        }

        // Interactive mode
        p.intro(pc.bgCyan(pc.black(" Markdown Template Gallery ")));

        while (true) {
            const selected = await p.select({
                message: "Choose a template to preview:",
                options: [
                    ...templates.map(t => ({
                        value: t.name,
                        label: t.title,
                        hint: t.file,
                    })),
                    { value: "__all__", label: "Render all templates" },
                    { value: "__exit__", label: pc.dim("Exit") },
                ],
            });

            if (p.isCancel(selected) || selected === "__exit__") {
                p.outro(pc.dim("Bye!"));
                break;
            }

            if (selected === "__all__") {
                for (const t of templates) {
                    const content = readFileSync(t.path, "utf-8");
                    console.log(pc.dim(`\n${"─".repeat(60)}`));
                    console.log(pc.bold(pc.cyan(`  Template: ${t.name}`)));
                    console.log(pc.dim(`${"─".repeat(60)}\n`));
                    console.log(renderMarkdownToCli(content));
                }
                continue;
            }

            const template = templates.find(t => t.name === selected);
            if (template) {
                const content = readFileSync(template.path, "utf-8");
                console.log("\n" + renderMarkdownToCli(content) + "\n");
            }
        }
    });

program.parse();
