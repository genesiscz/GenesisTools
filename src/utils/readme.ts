import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";
import { renderMarkdownToCli } from "./markdown/index.js";

/**
 * Print the README that sits next to a tool's entry, then exit. Only
 * `answerReadmeFlag` (`@genesiscz/utils/cli/readme-flag`) and `runTool` load
 * this module, and only by a dynamic import: its static import of the renderer
 * costs about 590 modules, so no entry may import it statically (lint rule
 * `no-static-readme-import`).
 *
 * @param toolDir - directory containing the tool's README.md
 * @returns never (always exits: 0 if found, 1 if missing)
 */
export function printReadmeAndExit(toolDir: string): never {
    const readmePath = resolve(toolDir, "README.md");

    if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8");
        // Piped/captured output gets plain text — ANSI leaks as literal escapes
        // there. The renderer owns the stripping, so this does not re-walk the
        // output a second time to undo what it just wrote.
        //
        // Boolean(), not the raw value: `isTTY` is UNDEFINED when stdout is a
        // pipe, and the renderer strips on `color === false` exactly, so passing
        // it through would colour piped output.
        out.println(renderMarkdownToCli(content, { color: Boolean(process.stdout.isTTY) }));
        process.exit(0);
    }

    out.println("No README.md found for this tool.");
    process.exit(1);
}
