import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { renderMarkdownToCli } from "./markdown/index.js";

/**
 * Print the README that sits next to a tool's entry, then exit. The
 * `runTool` bootstrap (and `handleReadmeFlag`) call this — the only
 * print+exit body.
 *
 * @param toolDir - directory containing the tool's README.md
 * @returns never (always exits: 0 if found, 1 if missing)
 */
export function printReadmeAndExit(toolDir: string): never {
    const readmePath = resolve(toolDir, "README.md");

    if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8");
        const rendered = renderMarkdownToCli(content);
        // Piped/captured output gets plain text — ANSI leaks as literal escapes there.
        out.println(process.stdout.isTTY ? rendered : stripAnsi(rendered));
        process.exit(0);
    }

    out.println("No README.md found for this tool.");
    process.exit(1);
}

/**
 * Handle --readme flag for CLI tools.
 * Call this early in your tool, passing import.meta.url.
 * If --readme is present in argv, prints README and exits.
 *
 * @param importMetaUrl - Pass `import.meta.url` from calling module
 * @returns void (exits process if --readme flag found)
 */
export function handleReadmeFlag(importMetaUrl: string): void {
    if (!process.argv.includes("--readme")) {
        return;
    }

    printReadmeAndExit(dirname(fileURLToPath(importMetaUrl)));
}
