import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";
import type { Command } from "commander";

/**
 * One entry per `tools claude` subcommand tree. Registering all 28 eagerly cost
 * every invocation the whole set: `history` alone pulls the DashboardApp barrel
 * (61.7 ms), because `defineDashboardApp` runs at registration time rather than
 * at action time.
 *
 * `registrars.test.ts` asserts that every `names` entry is what the registrar
 * really registers, so a renamed command cannot silently stop matching.
 */
export const CLAUDE_REGISTRARS: LazyRegistrar[] = [
    { names: ["export"], load: async () => (await import("./commands/export")).registerExportCommand },
    { names: ["history"], load: async () => (await import("./commands/history")).registerHistoryCommand },
    { names: ["memory"], load: async () => (await import("./commands/memory")).registerMemoryCommand },
    { names: ["summarize"], load: async () => (await import("./commands/summarize")).registerSummarizeCommand },
    { names: ["doctor"], load: async () => (await import("./commands/doctor")).registerDoctorCommand },
    { names: ["exec"], load: async () => (await import("./commands/exec")).registerExecCommand },
    { names: ["resume"], load: async () => (await import("./commands/resume")).registerResumeCommand },
    { names: ["tail"], load: async () => (await import("./commands/tail")).registerTailCommand },
    { names: ["transcript"], load: async () => (await import("./commands/transcript")).registerTranscriptCommand },
    { names: ["desktop"], load: async () => (await import("./commands/desktop")).registerDesktopCommand },
    { names: ["usage"], load: async () => (await import("./commands/usage")).registerUsageCommand },
    { names: ["code"], load: async () => (await import("./commands/code")).registerCodeCommand },
    { names: ["info"], load: async () => (await import("./commands/info")).registerInfoCommand },
    { names: ["config", "login"], load: async () => (await import("./commands/config")).registerConfigCommand },
    { names: ["daemon"], load: async () => (await import("./commands/daemon")).registerDaemonCommand },
    { names: ["migrate-to"], load: async () => (await import("./commands/migrate")).registerMigrateCommand },
    {
        names: ["warmup"],
        load: async () => {
            const register = (await import("@app/ai/commands/warmup")).registerWarmupCommand;

            return (program: Command) => register(program, { provider: "anthropic-sub", tool: "tools claude warmup" });
        },
    },
    { names: ["mcp"], load: async () => (await import("./commands/mcp")).registerMcpCommand },
    { names: ["login-long"], load: async () => (await import("./commands/login-long")).registerLoginLongCommand },
    {
        names: ["login-secondary"],
        load: async () => (await import("./commands/login-secondary")).registerLoginSecondaryCommand,
    },
    { names: ["logout"], load: async () => (await import("./commands/logout")).registerLogoutCommand },
    { names: ["anchor"], load: async () => (await import("./commands/anchor")).registerAnchorCommand },
    { names: ["spending"], load: async () => (await import("./commands/spending")).registerSpendingCommand },
    { names: ["start", "run"], load: async () => (await import("./commands/start")).registerStartCommand },
    { names: ["proxy"], load: async () => (await import("./commands/run")).registerRunCommand },
    { names: ["teams"], load: async () => (await import("./commands/teams")).registerTeamsCommand },
    { names: ["cmux"], load: async () => (await import("./commands/cmux")).registerCmuxCommand },
    { names: ["decide"], load: async () => (await import("./commands/decide")).registerDecideCommand },
    { names: ["who", "active"], load: async () => (await import("./commands/who")).registerWhoCommand },
    { names: ["worker"], load: async () => (await import("./commands/worker")).registerWorkerCommand },
];
