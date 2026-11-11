import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/** Root command trees in the same order as the CLI's help. A known name loads only its own tree. */
export const AI_PROXY_REGISTRARS: LazyRegistrar[] = [
    { names: ["up"], load: async () => (await import("./commands/registrars/up")).register },
    { names: ["down"], load: async () => (await import("./commands/registrars/down")).register },
    { names: ["install"], load: async () => (await import("./commands/registrars/install")).register },
    { names: ["uninstall"], load: async () => (await import("./commands/registrars/uninstall")).register },
    { names: ["status"], load: async () => (await import("./commands/registrars/status")).register },
    { names: ["serve"], load: async () => (await import("./commands/registrars/serve")).register },
    { names: ["models"], load: async () => (await import("./commands/registrars/models")).register },
    { names: ["sessions"], load: async () => (await import("./commands/registrars/sessions")).register },
    { names: ["session"], load: async () => (await import("./commands/registrars/session")).register },
    { names: ["stats"], load: async () => (await import("./commands/registrars/stats")).register },
    { names: ["monitor"], load: async () => (await import("./commands/registrars/monitor")).register },
    { names: ["calls"], load: async () => (await import("./commands/registrars/calls")).register },
    { names: ["link"], load: async () => (await import("./commands/registrars/link")).register },
    { names: ["clients"], load: async () => (await import("./commands/registrars/clients")).register },
    { names: ["introspect", "ls"], load: async () => (await import("./commands/registrars/introspect")).register },
    { names: ["config"], load: async () => (await import("./commands/registrars/config")).register },
    { names: ["usage"], load: async () => (await import("./commands/registrars/usage")).register },
    { names: ["accounts"], load: async () => (await import("./commands/registrars/accounts")).register },
    { names: ["internal"], load: async () => (await import("./commands/registrars/internal")).register },
];
