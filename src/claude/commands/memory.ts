import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { appendMemory, getMemoryPath, grepMemory, readMemory } from "../lib/memory";

export function registerMemoryCommand(program: Command): void {
    const memory = program.command("memory").description("Read/search/append project-scoped MEMORY.md");

    memory
        .command("path")
        .description("Print the absolute path to MEMORY.md for the current project")
        .action(() => {
            console.log(getMemoryPath());
        });

    memory
        .command("show")
        .description("Print MEMORY.md contents")
        .action(() => {
            const content = readMemory();

            if (content === null) {
                p.log.info(`No memory file at ${getMemoryPath()}`);
                return;
            }

            console.log(content);
        });

    memory
        .command("grep <pattern>")
        .description("Grep lines of MEMORY.md (case-insensitive substring)")
        .action((pattern: string) => {
            const matches = grepMemory(pattern);

            if (matches.length === 0) {
                p.log.info(`No matches for "${pattern}"`);
                return;
            }

            for (const line of matches) {
                console.log(line);
            }
        });

    memory
        .command("append <entry...>")
        .description("Append an entry (auto-prefixes '- ' if missing)")
        .action((entry: string[]) => {
            const text = entry.join(" ").trim();

            if (!text) {
                p.log.error("Empty entry");
                process.exit(1);
            }

            const path = appendMemory(text);
            p.log.success(`${pc.dim("Appended to")} ${path}`);
        });
}
