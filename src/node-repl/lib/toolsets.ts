import { isAbsolute } from "node:path";
import { ComputerToolset } from "@app/control/lib/computer-use/toolset";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { MoviesToolset } from "@app/recorder/lib/toolset";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ReplToolset, type ReplToolsetFactory } from "@genesiscz/utils/repl/toolset";
import { EditorToolset } from "@genesiscz/utils/repl/toolsets/editor";
import { RecorderToolset } from "@genesiscz/utils/repl/toolsets/recorder";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import { BrowserToolset } from "./toolsets/browser";
import { ControlToolset } from "./toolsets/control";
import { GithubToolset } from "./toolsets/github";
import { HubToolset } from "./toolsets/hub";
import { MeetingsToolset } from "./toolsets/meetings";
import { PresetsToolset } from "./toolsets/presets";

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
    movies: () => new MoviesToolset(),
    meetings: () => new MeetingsToolset(),
    control: () => new ControlToolset(),
    browser: () => new BrowserToolset(),
    hub: () => new HubToolset(),
    github: () => new GithubToolset(),
    // The store checks a saved preset's toolsets against this table, read when a preset is saved.
    presets: (): PresetsToolset => new PresetsToolset((): string[] => Object.keys(REPL_TOOLSETS)),
} satisfies Record<string, ReplToolsetFactory>;

export type ReplToolsetId = keyof typeof REPL_TOOLSETS;
export const REPL_TOOLSET_IDS = Object.keys(REPL_TOOLSETS) as ReplToolsetId[];

/**
 * The toolsets for `--help`: one line each and the command that prints one's whole API. Every method of all of them
 * was 535 lines (NR24); `help(name)` inside a turn prints the same docs `renderDocs` did.
 */
export function toolsetCliHelp(): string {
    const lines = REPL_TOOLSET_IDS.map((id) => {
        const { api } = REPL_TOOLSETS[id]();
        return `  ${id}: ${api.global === id ? "" : `(global ${api.global}) `}${api.summary}`;
    });
    const example = toolCommand(`node-repl run --toolset movies "help('movies')"`);
    return `\nToolsets (--toolset <list>, comma-separated):\n${lines.join("\n")}\n\nOne toolset's whole API: ${example}`;
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

/**
 * Why a `--toolset` list loads one API twice, or undefined. computer and control are one API under two names, and with
 * both every search() hit came back twice (NR14). The CLI refuses such a list; the table itself may hold both.
 */
export function toolsetOverlap(ids: readonly string[]): string | undefined {
    if (ids.includes("computer") && ids.includes("control")) {
        return "computer and control are one API under two names; load one of them";
    }

    return undefined;
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
