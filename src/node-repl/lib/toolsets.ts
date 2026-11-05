import { isAbsolute } from "node:path";
import { ComputerToolset } from "@app/control/lib/computer-use/toolset";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { renderDocs } from "@genesiscz/utils/api-descriptor";
import { ReplToolset, type ReplToolsetFactory } from "@genesiscz/utils/repl/toolset";
import { EditorToolset } from "@genesiscz/utils/repl/toolsets/editor";
import { RecorderToolset } from "@genesiscz/utils/repl/toolsets/recorder";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";

/**
 * Every toolset `--toolset` can preload by name. The table lives in the tool, not in `@genesiscz/utils/repl`,
 * because a toolset may sit in a tool's folder (computer is `src/control`), and `src/utils` may not import a tool.
 */
export const REPL_TOOLSETS = {
    computer: () => new ComputerToolset(),
    recorder: () =>
        new RecorderToolset(() =>
            FRAME_RECORDERS.native({ axTool: async (options) => [await ensureBinaryAsync(options)] })
        ),
    editor: () => new EditorToolset(),
} satisfies Record<string, ReplToolsetFactory>;

export type ReplToolsetId = keyof typeof REPL_TOOLSETS;
export const REPL_TOOLSET_IDS = Object.keys(REPL_TOOLSETS) as ReplToolsetId[];

export function toolsetCliHelp(): string {
    return `\nToolset APIs (JavaScript passed to run):\n\n${REPL_TOOLSET_IDS.map((id) => renderDocs(REPL_TOOLSETS[id]().api)).join("\n\n")}`;
}

export function isToolsetId(value: string): value is ReplToolsetId {
    return Object.hasOwn(REPL_TOOLSETS, value);
}

/** `/abs/path/module.ts#ExportName`: a toolset class outside the table, for a local experiment or a test. */
function isModuleEntry(value: string): boolean {
    const [path, name] = value.split("#");
    return isAbsolute(path) && Boolean(name);
}

/**
 * `"recorder,editor"` as entries, in order and without repeats; throws naming the known ids on an unknown one.
 * An entry is a table id or `/abs/path.ts#ExportName`.
 */
export function parseToolsetList(text: string | readonly string[]): string[] {
    const parts = (typeof text === "string" ? text.split(",") : text).map((part) => part.trim()).filter(Boolean);
    const unknown = parts.filter((part) => !isToolsetId(part) && !isModuleEntry(part));

    if (unknown.length > 0) {
        throw new Error(
            `Unknown toolset ${unknown.join(", ")}; known: ${REPL_TOOLSET_IDS.join(", ")} (or /abs/module.ts#ExportName)`
        );
    }

    return [...new Set(parts)];
}

export async function createToolsets(entries: readonly string[]): Promise<ReplToolset[]> {
    const toolsets: ReplToolset[] = [];

    for (const entry of parseToolsetList(entries)) {
        if (isToolsetId(entry)) {
            toolsets.push(REPL_TOOLSETS[entry]());
            continue;
        }

        const [path, name] = entry.split("#");
        const exported: unknown = (await import(path))[name];

        if (typeof exported !== "function") {
            throw new Error(`${path} exports no class ${name}`);
        }

        const instance: unknown = Reflect.construct(exported, []);

        if (!(instance instanceof ReplToolset)) {
            throw new Error(`${entry} is not a ReplToolset`);
        }

        toolsets.push(instance);
    }

    return toolsets;
}
