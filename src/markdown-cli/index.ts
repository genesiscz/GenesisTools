#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdownToCli } from "../utils/markdown/index.js";

const program = new Command();

program
    .name("markdown-cli")
    .description("Render markdown to beautiful CLI output")
    .argument("[file]", "Markdown file to render (or pipe via stdin)")
    .action((file?: string) => {
        let markdown: string;

        if (!process.stdin.isTTY) {
            markdown = readFileSync(0, "utf-8"); // fd 0 = stdin
        } else if (file) {
            const filePath = resolve(file);
            if (!existsSync(filePath)) {
                console.error(`File not found: ${filePath}`);
                process.exit(1);
            }
            markdown = readFileSync(filePath, "utf-8");
        } else {
            program.help();
            return;
        }

        console.log(renderMarkdownToCli(markdown));
    });

program.parse();
