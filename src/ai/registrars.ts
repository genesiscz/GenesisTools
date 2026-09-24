import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";
import type { Command } from "commander";

/**
 * One entry per `tools ai` subcommand tree. Registering all seven eagerly cost
 * every invocation the whole set, and the heaviest three (`usage` 186 ms,
 * `config` 184 ms, `accounts` 155 ms cold) are the ones `tools ai sessions`
 * never needs.
 *
 * The commands declared inline in `index.ts` (translate, summarize, image,
 * classify, models) stay eager: they are closures over this file's own
 * functions, and every module those functions need is imported at its use site.
 *
 * `registrars.test.ts` asserts that every `names` entry is what the registrar
 * really registers, so a renamed command cannot silently stop matching.
 */
export const AI_REGISTRARS: LazyRegistrar[] = [
    { names: ["accounts"], load: async () => (await import("./commands/accounts")).registerAccountsCommands },
    {
        names: ["codex"],
        load: async () => (await import("./commands/accounts/login")).registerAiProviderLoginCommands,
    },
    { names: ["config"], load: async () => (await import("./commands/config")).registerConfigCommands },
    { names: ["sessions"], load: async () => (await import("./commands/sessions")).registerSessionsCommands },
    { names: ["statusline"], load: async () => (await import("./commands/statusline")).registerStatuslineCommands },
    { names: ["tokens"], load: async () => (await import("./commands/tokens")).registerTokensCommands },
    {
        // `tools ai usage` opens the dashboard across every provider that reports quota; its
        // `daemon` subcommands own the one `ai-usage-poll` task (spec sections 6.5 and 7.5).
        names: ["usage"],
        load: async () => {
            const [{ registerAiUsageCommand }, { registerAiUsageSessionsCommand }, { registerUsageDaemonCommands }] =
                await Promise.all([
                    import("./commands/usage/index"),
                    import("./commands/usage/sessions"),
                    import("./commands/usage/daemon"),
                ]);

            return (program: Command) => {
                const usageCmd = program.command("usage").description("Usage limits for every AI provider");
                registerAiUsageCommand(usageCmd);
                registerAiUsageSessionsCommand(usageCmd);
                registerUsageDaemonCommands(usageCmd);
            };
        },
    },
    {
        names: ["warmup"],
        load: async () => {
            const register = (await import("./commands/warmup")).registerWarmupCommand;

            return (program: Command) => register(program, { tool: "tools ai warmup" });
        },
    },
];
