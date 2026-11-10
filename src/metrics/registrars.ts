import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/** One entry per `tools metrics` command file, in the order `--help` lists them. */
export const METRICS_REGISTRARS: LazyRegistrar[] = [
    { names: ["record"], load: async () => (await import("./commands/record")).registerRecordCommand },
    { names: ["query", "events"], load: async () => (await import("./commands/query")).registerQueryCommands },
    { names: ["tail"], load: async () => (await import("./commands/tail")).registerTailCommand },
    {
        names: ["define", "list", "status", "prune"],
        load: async () => (await import("./commands/catalog")).registerCatalogCommands,
    },
    { names: ["connect"], load: async () => (await import("./commands/connect")).registerConnectCommand },
    { names: ["import"], load: async () => (await import("./commands/import")).registerImportCommand },
    { names: ["serve"], load: async () => (await import("./commands/serve")).registerServeCommand },
];
