import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/**
 * One entry per `tools meetings` command file, in the order `--help` lists them. Registering all 14 eagerly cost every
 * call about 320 ms of CPU, as much as `--help` (2026-11-06): `config show --json` loaded the recorder, the screen
 * boxes and the watcher too. A name missing here only falls back to loading every tree, never to a missing command.
 */
export const MEETINGS_REGISTRARS: LazyRegistrar[] = [
    {
        names: ["new", "list", "ls", "show", "revisions", "set", "link", "merge", "context"],
        load: async () => (await import("./commands/meeting")).registerMeetingCommands,
    },
    {
        names: ["suggest", "items", "confirm", "reject", "reopen", "speakers", "transcript"],
        load: async () => (await import("./commands/items")).registerItemCommands,
    },
    { names: ["evidence"], load: async () => (await import("./commands/evidence")).registerEvidenceCommand },
    { names: ["attendance"], load: async () => (await import("./commands/attendance")).registerAttendanceCommand },
    { names: ["record", "screen"], load: async () => (await import("./commands/record")).registerRecordCommands },
    { names: ["screen-note"], load: async () => (await import("./commands/screen-note")).registerScreenNoteCommand },
    { names: ["play"], load: async () => (await import("./commands/play")).registerPlayCommand },
    { names: ["listen"], load: async () => (await import("./commands/listen")).registerListenCommand },
    { names: ["watch", "autostart"], load: async () => (await import("./commands/watch")).registerWatchCommands },
    { names: ["projects"], load: async () => (await import("./commands/projects")).registerProjectsCommand },
    { names: ["assign"], load: async () => (await import("./commands/assign")).registerAssignCommands },
    { names: ["dictionary"], load: async () => (await import("./commands/dictionary")).registerDictionaryCommand },
    {
        names: ["window", "overview", "export"],
        load: async () => (await import("./commands/views")).registerViewCommands,
    },
    { names: ["config"], load: async () => (await import("./commands/config")).registerConfigCommand },
];
