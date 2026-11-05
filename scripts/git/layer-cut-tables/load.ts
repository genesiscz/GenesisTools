import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CutTable } from "./types";
import unified from "./unified";

/** Table modules are trusted local TypeScript, resolved relative to the invoking directory. */
export async function loadTable(argv: string[]): Promise<CutTable> {
    const index = argv.indexOf("--table");
    if (index === -1) {
        return unified;
    }

    const file = argv[index + 1];
    if (!file || file.startsWith("--")) {
        throw new Error("--table <module path> requires a path");
    }

    const loaded = await import(pathToFileURL(resolve(file)).href);
    const table: CutTable = loaded.default;
    if (
        !table ||
        !Array.isArray(table.branches) ||
        !table.defaults ||
        !table.keepAtBase ||
        !["commits", "diff"].includes(table.selection) ||
        !table.refPrefix?.startsWith("refs/heads/cut/")
    ) {
        throw new Error(`${file}: expected a default CutTable export`);
    }

    return table;
}
