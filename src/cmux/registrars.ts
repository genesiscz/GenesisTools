import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/**
 * One entry per `tools cmux` subcommand, loaded only when argv asks for it. Registering all of them
 * eagerly made `tools cmux tree` pay ~100 ms of imports it never used (621 ms against 419 ms for the
 * lazily-registered `tools ai cmux tree`, hyperfine 2026-09-24).
 */
export const CMUX_REGISTRARS: LazyRegistrar[] = [
    { names: ["capture"], load: async () => (await import("./commands/capture")).registerCaptureCommand },
    { names: ["profiles"], load: async () => (await import("./commands/profiles")).registerProfilesCommand },
    {
        names: ["restore-after-restart"],
        load: async () => (await import("./commands/restore-after-restart")).registerRestoreAfterRestartCommand,
    },
    { names: ["send-self"], load: async () => (await import("./commands/send-self")).registerSendSelfCommand },
    { names: ["doctor"], load: async () => (await import("./commands/doctor")).registerDoctorCommand },
    { names: ["launch"], load: async () => (await import("./commands/launch")).registerLaunchCommand },
    { names: ["rescue"], load: async () => (await import("./commands/rescue")).registerRescueCommand },
    { names: ["tree"], load: async () => (await import("./commands/tree")).registerTreeCommand },
];
