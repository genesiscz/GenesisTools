#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import * as p from "@clack/prompts";
import clipboardy from "clipboardy";
import pc from "picocolors";

import { discoverTools, getReadme, type ToolInfo } from "./lib/discovery.js";
import { introspectTool } from "./lib/introspect.js";
import { renderMarkdownToCli } from "../utils/markdown/index.js";
import {
    searchSelect,
    searchSelectCancelSymbol,
} from "../utils/prompts/clack/search-select.js";

const LOGO = pc.cyan(`
  ╔═══════════════════════════════════╗
  ║         GenesisTools CLI          ║
  ╚═══════════════════════════════════╝
`);

async function handleToolAction(tool: ToolInfo, srcDir: string): Promise<void> {
    const options: { value: string; label: string; hint?: string }[] = [
        { value: "run", label: "Run", hint: `tools ${tool.name}` },
    ];

    if (tool.hasReadme) {
        options.push({ value: "readme", label: "View README" });
    }

    options.push(
        { value: "help", label: "Explore subcommands", hint: "--help" },
        { value: "copy", label: "Copy command to clipboard" },
        { value: "back", label: "Back to list" },
    );

    const action = await p.select({
        message: `${pc.bold(tool.name)} \u2014 what do you want to do?`,
        options,
    });

    if (p.isCancel(action) || action === "back") return;

    if (action === "run") {
        p.outro(`Running ${pc.bold(`tools ${tool.name}`)}...`);
        const result = spawnSync("bun", ["run", tool.path], {
            stdio: "inherit",
            cwd: process.cwd(),
        });
        process.exit(result.status ?? 0);
    }

    if (action === "readme") {
        const readme = getReadme(srcDir, tool.name);
        if (readme) {
            console.log("\n" + renderMarkdownToCli(readme) + "\n");
        } else {
            p.log.warn("No README.md found for this tool.");
        }
        // After viewing, show action menu again
        await handleToolAction(tool, srcDir);
        return;
    }

    if (action === "help") {
        const help = introspectTool(tool.path);
        if (!help || (help.commands.length === 0 && help.options.length === 0)) {
            p.log.warn("No subcommands or options found.");
            await handleToolAction(tool, srcDir);
            return;
        }

        if (help.commands.length > 0) {
            const cmdOptions: { value: string; label: string; hint?: string }[] = [
                ...help.commands.map((c) => ({
                    value: c.name,
                    label: c.name,
                    hint: c.description,
                })),
                { value: "__back__", label: pc.dim("Back") },
            ];

            const cmd = await p.select({
                message: `${pc.bold(tool.name)} subcommands:`,
                options: cmdOptions,
            });

            if (!p.isCancel(cmd) && cmd !== "__back__") {
                const command = `tools ${tool.name} ${cmd}`;
                await clipboardy.write(command);
                p.log.success(`Copied: ${pc.bold(command)}`);
            }
        }

        if (help.options.length > 0) {
            p.log.info(pc.bold("Options:"));
            for (const opt of help.options) {
                console.log(`  ${pc.cyan(opt.flags)}  ${pc.dim(opt.description)}`);
            }
            console.log();
        }

        await handleToolAction(tool, srcDir);
        return;
    }

    if (action === "copy") {
        const command = `tools ${tool.name}`;
        await clipboardy.write(command);
        p.log.success(`Copied: ${pc.bold(command)}`);
    }
}

async function main(): Promise<void> {
    const srcDir = resolve(import.meta.dirname, "..");

    console.log(LOGO);
    p.intro(pc.bgCyan(pc.black(" Tools Browser ")));

    const tools = discoverTools(srcDir);

    if (tools.length === 0) {
        p.log.warn("No tools found.");
        process.exit(0);
    }

    p.log.info(
        `${pc.bold(String(tools.length))} tools available. Type to search.`,
    );

    // Main loop
    while (true) {
        const selected = await searchSelect<string>({
            message: "Search tools:",
            items: tools.map((t) => ({
                value: t.name,
                label: t.name,
                hint: t.description,
            })),
            maxVisible: 12,
        });

        if (
            selected === searchSelectCancelSymbol ||
            selected === undefined
        ) {
            p.outro(pc.dim("Bye!"));
            break;
        }

        const tool = tools.find((t) => t.name === selected);
        if (!tool) continue;

        await handleToolAction(tool, srcDir);
    }
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
