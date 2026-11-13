import { isAbsolute } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { ReplToolset, ReplToolsetRow } from "@genesiscz/utils/repl/toolset";

/**
 * Every toolset `--toolset` can preload by name. The table lives in the tool, not in `@genesiscz/utils/repl`,
 * because a toolset may sit in a tool's folder (computer is `src/control`), and `src/utils` may not import a tool.
 *
 * A row imports nothing until `load` runs: --help, id parsing and the MCP start line read `summary` and `global`,
 * and a worker loads only the rows its run names. The summaries repeat each toolset's `api.summary`, and a test in
 * engine.test.ts pins every row to its loaded toolset, so the two cannot drift.
 */
export const REPL_TOOLSETS = {
    computer: {
        summary:
            "Observe and operate native macOS apps through AX, CoreGraphics and Vision; observe with get_app_state first.",
        load: async (): Promise<ReplToolset> => {
            const { ComputerToolset } = await import("@app/control/lib/computer-use/toolset");
            return new ComputerToolset();
        },
    },
    recorder: {
        summary:
            "Start, attach to and control frames recordings (PNG frames for editor) over the live recording socket; for a movie to cut and export, use movies.record.",
        load: async (): Promise<ReplToolset> => {
            const [{ RecorderToolset }, { FRAME_RECORDERS }, { ensureBinaryAsync }] = await Promise.all([
                import("@genesiscz/utils/repl/toolsets/recorder"),
                import("@genesiscz/utils/screen-recorder/recorders"),
                import("@app/control/lib/runner"),
            ]);
            return new RecorderToolset(() =>
                FRAME_RECORDERS.native({ axTool: async (options) => [await ensureBinaryAsync(options)] })
            );
        },
    },
    editor: {
        summary:
            "Cut recordings and videos into frames, change-only frames, image grids, trims, speed changes and exports; a movie made with movies.record is edited with movies.open. Frames, grids, trims and speed changes stay under ~/.genesis-tools/recordings/edits/<source>/ after the worker stops; export takes an output path.",
        load: async (): Promise<ReplToolset> => {
            const { EditorToolset } = await import("@genesiscz/utils/repl/toolsets/editor");
            return new EditorToolset();
        },
    },
    movies: {
        summary:
            "Record the screen as a movie, then cut, speed up, zoom and export it; the recorder window shows each edit. Use it for a demo video; recorder and editor are the lower-level frames tools.",
        load: async (): Promise<ReplToolset> => {
            const { MoviesToolset } = await import("@app/recorder/lib/toolset");
            return new MoviesToolset();
        },
    },
    meetings: {
        summary:
            "List and open meetings; read their corrected transcript, evidence and items; suggest, confirm and reject items; name speakers.",
        load: async (): Promise<ReplToolset> => {
            const { MeetingsToolset } = await import("./toolsets/meetings");
            return new MeetingsToolset();
        },
    },
    // Its own row, not a field of computer's: ControlToolset wraps a ComputerToolset and renames the binding.
    control: {
        summary:
            "The computer toolset's API under the name control (the same methods and docs); load computer or control, not both.",
        load: async (): Promise<ReplToolset> => {
            const { ControlToolset } = await import("./toolsets/control");
            return new ControlToolset();
        },
    },
    browser: {
        summary: `Open, read, navigate, screenshot and close browser tabs through Chrome DevTools; ${toolCommand("chrome-devtools")} has click, fill and snapshot.`,
        load: async (): Promise<ReplToolset> => {
            const { BrowserToolset } = await import("./toolsets/browser");
            return new BrowserToolset();
        },
    },
    hub: {
        summary: "Read pull requests across repository hosts.",
        load: async (): Promise<ReplToolset> => {
            const { HubToolset } = await import("./toolsets/hub");
            return new HubToolset();
        },
    },
    github: {
        summary: "Read GitHub pull request reviews.",
        load: async (): Promise<ReplToolset> => {
            const { GithubToolset } = await import("./toolsets/github");
            return new GithubToolset();
        },
    },
    presets: {
        summary:
            "Save a script that worked as a named preset with parameters, list them, run one again with other values.",
        load: async (): Promise<ReplToolset> => {
            const { PresetsToolset } = await import("./toolsets/presets");
            // The store checks a saved preset's toolsets against this table, read when a preset is saved.
            return new PresetsToolset((): string[] => Object.keys(REPL_TOOLSETS));
        },
    },
} satisfies Record<string, ReplToolsetRow>;

export type ReplToolsetId = keyof typeof REPL_TOOLSETS;
export const REPL_TOOLSET_IDS = Object.keys(REPL_TOOLSETS) as ReplToolsetId[];

/**
 * The toolsets for `--help`: one line each and the command that prints one's whole API. Every method of all of them
 * was 535 lines (NR24); `help(name)` inside a turn lists one line per method (`renderBrief`), describe(name) the rest.
 */
export function toolsetCliHelp(): string {
    const lines = REPL_TOOLSET_IDS.map((id) => {
        const global = toolsetGlobal(id);
        return `  ${id}: ${global === id ? "" : `(global ${global}) `}${REPL_TOOLSETS[id].summary}`;
    });
    const example = toolCommand(`node-repl run --toolset movies "help('movies')"`);
    return `\nToolsets (--toolset <list>, comma-separated):\n${lines.join("\n")}\n\nOne toolset's whole API: ${example}`;
}

export function isToolsetId(value: string): value is ReplToolsetId {
    return Object.hasOwn(REPL_TOOLSETS, value);
}

/** The global a table toolset binds, read from its row. */
export function toolsetGlobal(id: ReplToolsetId): string {
    const row: ReplToolsetRow = REPL_TOOLSETS[id];
    return row.global ?? id;
}

/** The line the `js` tool description carries for a table toolset, as `ReplToolset.oneLine()` renders it, unloaded. */
export function toolsetOneLine(id: ReplToolsetId): string {
    return `${toolsetGlobal(id)}: ${REPL_TOOLSETS[id].summary}`;
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

export interface CreatedToolsets {
    loaded: ReplToolset[];
    /** The entries whose module threw or whose class is not a toolset; the others still load. */
    failed: { id: string; reason: string }[];
}

/**
 * Loads each entry in its own try, so a module that throws at import fails alone (NR2). An unknown id still throws:
 * that is the caller's mistake, refused before anything loads.
 */
export async function createToolsets(entries: readonly string[]): Promise<CreatedToolsets> {
    const created: CreatedToolsets = { loaded: [], failed: [] };

    for (const entry of parseToolsetList(entries)) {
        try {
            created.loaded.push(isToolsetId(entry) ? await REPL_TOOLSETS[entry].load() : await loadModuleEntry(entry));
        } catch (error) {
            created.failed.push({ id: entry, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    return created;
}

async function loadModuleEntry(entry: string): Promise<ReplToolset> {
    const [path, name] = entry.split("#");
    const [imported, { ReplToolset }] = await Promise.all([import(path), import("@genesiscz/utils/repl/toolset")]);
    const exported: unknown = imported[name];

    if (typeof exported !== "function") {
        throw new Error(`${path} exports no class ${name}`);
    }

    const instance: unknown = Reflect.construct(exported, []);

    if (!(instance instanceof ReplToolset)) {
        throw new Error(`${entry} is not a ReplToolset`);
    }

    return instance;
}
