import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/** One entry per `tools agents` subcommand tree, in the order `--help` lists them; a call loads only its own tree. */
export const AGENTS_REGISTRARS: LazyRegistrar[] = [
    { names: ["login"], load: async () => (await import("./commands/login")).registerLoginCommand },
    { names: ["message"], load: async () => (await import("./commands/message")).registerMessageCommand },
    { names: ["leave"], load: async () => (await import("./commands/leave")).registerLeaveCommand },
    { names: ["request"], load: async () => (await import("./commands/request")).registerRequestCommand },
    { names: ["discover"], load: async () => (await import("./commands/discover")).registerDiscoverCommand },
    { names: ["listen"], load: async () => (await import("./commands/listen")).registerListenCommand },
    { names: ["hooks"], load: async () => (await import("./commands/hooks")).registerHooksCommands },
    { names: ["changes"], load: async () => (await import("./commands/changes")).registerChangesCommand },
    { names: ["blame"], load: async () => (await import("./commands/blame")).registerBlameCommand },
];
