import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/**
 * The `tools hub` subcommand trees that live in their own files, in the order `--help` lists them (after the inline
 * open, proposal, status, repo, timeline and pr trees of `cli.ts`). Registering all of them eagerly made every hub
 * call pay for every tree: the app's door-less `hub pr …` calls loaded about 1,445 modules (2026-11-10).
 *
 * `agents` and `serve` are rows here only so `hub --help` lists them: `index.ts` sends a `hub agents` or
 * `hub serve` call to its own small entry before this table is read.
 */
export const HUB_REGISTRARS: LazyRegistrar[] = [
    { names: ["worktrees"], load: async () => (await import("./lib/worktrees-command")).registerWorktreesCommand },
    { names: ["notify"], load: async () => (await import("./commands/notify")).registerNotifyCommands },
    { names: ["config"], load: async () => (await import("./commands/config")).registerConfigCommands },
    { names: ["search"], load: async () => (await import("./commands/search")).registerSearchCommand },
    { names: ["digest"], load: async () => (await import("./commands/digest")).registerDigestCommand },
    { names: ["forecast"], load: async () => (await import("./commands/forecast")).registerForecastCommand },
    { names: ["rules"], load: async () => (await import("./commands/rules")).registerRulesCommand },
    { names: ["nav"], load: async () => (await import("./commands/nav")).registerNavCommands },
    { names: ["link"], load: async () => (await import("./commands/link")).registerLinkCommand },
    {
        names: ["insights", "stuck", "handoff"],
        load: async () => (await import("./commands/insights")).registerInsightsCommands,
    },
    { names: ["procs"], load: async () => (await import("./commands/procs")).registerProcsCommand },
    { names: ["board"], load: async () => (await import("./commands/board")).registerBoardCommand },
    { names: ["triage"], load: async () => (await import("./commands/triage")).registerTriageCommand },
    { names: ["gates"], load: async () => (await import("./commands/gates")).registerGatesCommand },
    { names: ["approvals"], load: async () => (await import("./commands/approvals")).registerApprovalsCommand },
    { names: ["glance"], load: async () => (await import("./commands/glance")).registerGlanceCommand },
    { names: ["ping"], load: async () => (await import("./commands/ping")).registerPingCommand },
    { names: ["launch"], load: async () => (await import("./commands/launch")).registerLaunchCommand },
    { names: ["watching"], load: async () => (await import("./commands/watching")).registerWatchingCommand },
    { names: ["brief"], load: async () => (await import("./commands/brief")).registerBriefCommand },
    { names: ["wake"], load: async () => (await import("./commands/wake")).registerWakeCommand },
    { names: ["timesheet"], load: async () => (await import("./commands/timesheet")).registerTimesheetCommand },
    { names: ["vault"], load: async () => (await import("./commands/vault")).registerVaultCommand },
    { names: ["memos"], load: async () => (await import("./commands/memos")).registerMemosCommand },
    { names: ["snap"], load: async () => (await import("./commands/snap")).registerSnapCommand },
    { names: ["prompts"], load: async () => (await import("./commands/prompts")).registerPromptsCommand },
    { names: ["agents"], load: async () => (await import("./commands/agents")).registerAgentsCommand },
    { names: ["serve"], load: async () => (await import("./server/command")).registerServeCommand },
    { names: ["dev"], load: async () => (await import("./commands/dev")).registerDevCommands },
];
