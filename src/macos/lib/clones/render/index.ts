import { isInteractive } from "@app/utils/cli";
import { JsonRenderer } from "./json";
import { TableRenderer } from "./table";
import type { CloneRenderer, Format } from "./types";

export * from "./types";
export { JsonRenderer } from "./json";
export { TableRenderer } from "./table";

/** Resolve a `--format` flag to a concrete format. `auto`/undefined →
 *  `table` when interactive, else `json` (mirrors src/todo/lib/format.ts). */
export function resolveFormat(flag: string | undefined): Exclude<Format, "auto"> {
    if (flag === "table" || flag === "json" || flag === "jsonl") {
        return flag;
    }

    return isInteractive() ? "table" : "json";
}

/** The single renderer swap point. `jsonl` shares JsonRenderer; callers that
 *  need raw op streaming call `(renderer as JsonRenderer).processReportJsonl`. */
export function resolveRenderer(format: Exclude<Format, "auto">): CloneRenderer {
    if (format === "table") {
        return new TableRenderer();
    }

    return new JsonRenderer();
}
