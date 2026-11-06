import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";
import {
    listPresets,
    noteRun,
    presetNameSchema,
    readPreset,
    removePreset,
    resolveParams,
    savePreset,
    savePresetSchema,
} from "../presets";

const { log } = logger.scoped("node-repl-presets");

const nameOnly = z.object({ name: presetNameSchema });

const save = defineMethod({
    name: "save",
    params: z.object({ name: presetNameSchema, preset: savePresetSchema }),
    positional: ["name", "preset"],
    result: z.unknown(),
    resultName: "{ name, folder, toolsets, params }",
    effect: "reversible",
    doc: 'Saves a script that worked as a named preset (saving the same name again replaces it): { script, description?, toolsets?, params? }. The script is the body of an async function: it reads its values from `params` and returns what the run gives back. params declares each value: { url: { type: "string" | "number" | "boolean" | "json", description?, default? } }; one without a default is required at every run. toolsets defaults to the toolsets the script names (movies., computer.).',
});
const list = defineMethod({
    name: "list",
    params: z.object({}),
    result: z.unknown(),
    resultName: "{ name, description?, toolsets, params, runs, lastRunAt? }[]",
    effect: "read",
    doc: "The saved presets, by name, with their params and how often each ran.",
});
const show = defineMethod({
    name: "show",
    params: nameOnly,
    positional: ["name"],
    result: z.unknown(),
    resultName: "{ meta, script, folder }",
    effect: "read",
    doc: "One preset: its metadata, its script and its folder (edit script.js there to change it).",
});
const run = defineMethod({
    name: "run",
    params: z.object({ name: presetNameSchema, values: z.record(z.string(), z.unknown()).optional() }),
    positional: ["name", "values"],
    result: z.unknown(),
    resultName: "what the preset's script returns",
    effect: "reversible",
    doc: 'Runs a preset in this REPL with other values: presets.run("signup-demo", { url: "https://example.org" }). The defaults fill what is not given; an unknown or missing required value is refused before anything runs. The toolsets the preset needs must be loaded (start the REPL with --toolset).',
});
const remove = defineMethod({
    name: "remove",
    params: nameOnly,
    positional: ["name"],
    result: z.unknown(),
    resultName: "{ trash }",
    effect: "reversible",
    doc: "Moves a preset to the presets folder's .trash/, from where it can be moved back.",
});

type AsyncBody = (params: Record<string, unknown>) => Promise<unknown>;
/** The constructor of async functions, which the language does not name as a global. */
const AsyncFunction: new (...args: string[]) => AsyncBody = Object.getPrototypeOf(async () => undefined).constructor;

/**
 * Runs a preset's script as the body of an async function in the REPL's own global scope, so it sees every loaded
 * toolset (movies, computer, …) as a turn would. Throws naming the toolsets it needs that are not loaded.
 */
export async function runPresetHere(
    name: string,
    values: Record<string, unknown> = {},
    root?: string
): Promise<unknown> {
    const preset = readPreset(name, root);
    const params = resolveParams(preset.meta, values);
    const missing = preset.meta.toolsets.filter((id) => !Reflect.has(globalThis, id));

    if (missing.length > 0) {
        throw new Error(
            `preset ${name} needs the ${missing.join(", ")} toolset${missing.length === 1 ? "" : "s"}; load ${missing.length === 1 ? "it" : "them"} with --toolset ${[...new Set([...preset.meta.toolsets, "presets"])].join(",")}`
        );
    }

    log.info({ name, params: Object.keys(params), toolsets: preset.meta.toolsets }, "preset run");
    // The sourceURL names the script's frames `preset:<name>`, which the worker shows as `preset <name>:<line>`.
    const body = new AsyncFunction("params", `${preset.script}\n//# sourceURL=preset:${name}`);
    const result = await body(params);
    noteRun(name, root);
    return result;
}

/** `presets`: save a REPL script that worked under a name, list the saved ones, and run one again with other values. */
export class PresetsToolset extends ReplToolset {
    readonly api = defineApi({
        id: "presets",
        global: "presets",
        title: "REPL presets",
        summary:
            "Save a script that worked as a named preset with parameters, list them, run one again with other values.",
        methods: [save, list, show, run, remove],
        notes: [
            `A preset lives in ~/.genesis-tools/node-repl/presets/<name>/ (script.js and preset.json); \`${toolCommand("node-repl preset run")} <name> --param key=value\` runs it from a shell.`,
        ],
    });

    constructor(private readonly knownToolsets: () => readonly string[]) {
        super();
    }

    async bootstrap(): Promise<Record<string, unknown>> {
        return {
            presets: {
                save: (name: string, preset: z.input<typeof savePresetSchema>) => {
                    const saved = savePreset({ name, input: preset, knownToolsets: this.knownToolsets() });
                    return {
                        name: saved.meta.name,
                        folder: saved.folder,
                        toolsets: saved.meta.toolsets,
                        params: saved.meta.params,
                    };
                },
                list: () => listPresets(),
                show: (name: string) => readPreset(name),
                run: (name: string, values?: Record<string, unknown>) => runPresetHere(name, values),
                remove: (name: string) => ({ trash: removePreset(name) }),
            },
        };
    }
}
