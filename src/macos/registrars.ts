import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/**
 * lazy: saves ~180 ms cold import and ~57 MB RSS on every recognised subcommand
 * (tools ts imports analyze, 2026-09-16) — importing all the trees eagerly made
 * `tools macos clones measure` pay for Mail, Calendar, Reminders and Messages
 * before it did any work.
 *
 * Per-tree import cost of the old eager list, measured: mail 237 ms,
 * voice-memos 169 ms, clones 90 ms, messages 69 ms, calendar 37 ms,
 * reminders 35 ms, permissions 29 ms, swap 26 ms, sleep 23 ms, control 6 ms.
 * Mail alone was 237 ms of a 284 ms tree, so this is about the SUBCOMMANDS;
 * making DarwinKit (23 ms) lazy on its own measured no improvement at all.
 *
 * Help and an unknown subcommand still need every description, so those load
 * the lot and are deliberately no faster; only a recognised subcommand takes
 * the fast path. The order below IS the order `--help` lists them in, so it
 * mirrors the original sequence of registerX calls rather than sorting
 * alphabetically: `permissions` sat third and a diff of `tools macos --help`
 * caught it moving.
 */
export const MACOS_REGISTRARS: LazyRegistrar[] = [
    {
        names: ["calendar"],
        load: async () => (await import("@app/macos/commands/calendar/index")).registerCalendarCommand,
    },
    {
        names: ["clones", "apfs"],
        load: async () => (await import("@app/macos/commands/clones/index")).registerClonesCommand,
    },
    { names: ["doctor"], load: async () => (await import("@app/macos/commands/doctor/index")).registerDoctorCommand },
    {
        names: ["permissions"],
        load: async () => (await import("@app/macos/commands/permissions/index")).registerPermissionsCommand,
    },
    {
        names: ["control"],
        load: async () => (await import("@app/macos/commands/control/index")).registerControlCommand,
    },
    { names: ["mail"], load: async () => (await import("@app/macos/commands/mail/index")).registerMailCommand },
    {
        names: ["messages"],
        load: async () => (await import("@app/macos/commands/messages/index")).registerMessagesCommand,
    },
    {
        names: ["reminders"],
        load: async () => (await import("@app/macos/commands/reminders/index")).registerRemindersCommand,
    },
    { names: ["sleep"], load: async () => (await import("@app/macos/commands/sleep/index")).registerSleepCommand },
    { names: ["swap"], load: async () => (await import("@app/macos/commands/swap/index")).registerSwapCommand },
    {
        names: ["voice-memos"],
        load: async () => (await import("@app/macos/commands/voice-memos/index")).registerVoiceMemosCommand,
    },
    {
        names: ["eslogger"],
        load: async () => (await import("@app/macos/commands/eslogger/index")).registerEsloggerCommand,
    },
    {
        names: ["clicky-library"],
        load: async () => (await import("@app/macos/commands/clicky-library/index")).registerClickyLibraryCommand,
    },
];
