import { acceptJsonEverywhere, suggestOnlySafeCommands } from "@genesiscz/utils/cli/commander-hints";
import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";

type Register = (program: Command) => void;

/** The commands an unknown one may be told it meant: they change nothing (no stop, start or undo). */
const READ_ONLY_COMMANDS = [
    "status",
    "list",
    "show",
    "info",
    "search",
    "markers",
    "comments",
    "check",
    "items-at",
    "project",
    "words",
    "opened",
    "click-groups",
    "library",
    "help",
];

/** The root `tools recorder` command, without its trees: `RECORDER_REGISTRARS` adds the ones argv asks for. */
export function createRecorderProgram(): Command {
    const program = new Command()
        .name("recorder")
        .description(
            "Screen recordings with a movie editor: record the screen, a window or an app with audio and the cursor, then cut, zoom and export in the recorder window or from the command line"
        );
    suggestOnlySafeCommands(program, READ_ONLY_COMMANDS);

    return program;
}

/**
 * Every recorder command takes `--json`, the ones without their own as a flag that changes nothing. It is added after
 * each tree registers, so a tree that argv loaded alone gets it too; a command that has `--json` already keeps its own.
 */
function withJsonEverywhere(load: () => Promise<Register>): () => Promise<Register> {
    return async () => {
        const register = await load();

        return (program) => {
            register(program);
            acceptJsonEverywhere(program, "accepted for scripts; the output is the same with or without it");
        };
    };
}

/** Root command trees in the same order as the CLI's help. A known name loads only its own tree. */
export const RECORDER_REGISTRARS: LazyRegistrar[] = [
    { names: ["start"], load: async () => (await import("./commands/registrars/start")).register },
    {
        names: ["stop", "pause", "resume", "status", "mark"],
        load: async () => (await import("./commands/registrars/live")).register,
    },
    { names: ["undo"], load: async () => (await import("./commands/registrars/undo")).register },
    { names: ["redo"], load: async () => (await import("./commands/registrars/redo")).register },
    { names: ["rename"], load: async () => (await import("./commands/registrars/rename")).register },
    { names: ["import"], load: async () => (await import("./commands/registrars/import")).register },
    { names: ["copy"], load: async () => (await import("./commands/registrars/copy")).register },
    { names: ["reveal"], load: async () => (await import("./commands/registrars/reveal")).register },
    { names: ["trash"], load: async () => (await import("./commands/registrars/trash")).register },
    {
        names: ["comment", "comments", "resolve", "uncomment"],
        load: async () => (await import("./commands/registrars/review")).register,
    },
    { names: ["demo"], load: async () => (await import("./commands/registrars/demo")).register },
    { names: ["markers"], load: async () => (await import("./commands/registrars/markers")).register },
    { names: ["click-groups"], load: async () => (await import("./commands/registrars/click-groups")).register },
    { names: ["replace-words"], load: async () => (await import("./commands/registrars/replace-words")).register },
    { names: ["check"], load: async () => (await import("./commands/registrars/check")).register },
    { names: ["items-at"], load: async () => (await import("./commands/registrars/items-at")).register },
    { names: ["fix"], load: async () => (await import("./commands/registrars/fix")).register },
    { names: ["sheet"], load: async () => (await import("./commands/registrars/sheet")).register },
    { names: ["still"], load: async () => (await import("./commands/registrars/still")).register },
    { names: ["search"], load: async () => (await import("./commands/registrars/search")).register },
    { names: ["list"], load: async () => (await import("./commands/registrars/list")).register },
    { names: ["show", "info"], load: async () => (await import("./commands/registrars/show")).register },
    { names: ["library"], load: async () => (await import("./commands/registrars/library")).register },
    { names: ["opened"], load: async () => (await import("./commands/registrars/opened")).register },
    { names: ["edit"], load: async () => (await import("./commands/registrars/edit")).register },
    { names: ["window"], load: async () => (await import("./commands/registrars/window")).register },
    { names: ["project"], load: async () => (await import("./commands/registrars/project")).register },
    { names: ["apply"], load: async () => (await import("./commands/registrars/apply")).register },
    { names: ["export"], load: async () => (await import("./commands/registrars/export")).register },
    { names: ["finish"], load: async () => (await import("./commands/registrars/finish")).register },
    { names: ["cut-words"], load: async () => (await import("./commands/registrars/cut-words")).register },
    { names: ["words"], load: async () => (await import("./commands/registrars/words")).register },
    { names: ["transcribe"], load: async () => (await import("./commands/registrars/transcribe")).register },
    { names: ["cut-fillers"], load: async () => (await import("./commands/registrars/cut-fillers")).register },
    { names: ["subtitles"], load: async () => (await import("./commands/registrars/subtitles")).register },
    { names: ["proxy"], load: async () => (await import("./commands/registrars/proxy")).register },
    { names: ["find-screen"], load: async () => (await import("./commands/registrars/find-screen")).register },
    { names: ["duplicate"], load: async () => (await import("./commands/duplicate")).registerDuplicateCommand },
    {
        names: ["private-data", "waits", "events", "snap"],
        load: async () => (await import("./commands/fx-analysis")).registerFxAnalysisCommands,
    },
    {
        names: ["find-text", "verify-hidden"],
        load: async () => (await import("./commands/fx-analysis")).registerHideTextCommands,
    },
    { names: ["serve"], load: async () => (await import("./commands/serve")).registerServeCommand },
].map((entry) => ({ names: entry.names, load: withJsonEverywhere(entry.load) }));
