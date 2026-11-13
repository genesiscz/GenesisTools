import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";
import type { Command } from "commander";

/**
 * One entry per `tools codex` subcommand tree, in the order `--help` lists them. Registering every tree eagerly made
 * `codex logs --help` load the same 1,019 modules as `codex --help` (2026-11-10): the shared agent verbs alone pull
 * the worker drivers, the account login and the usage TUI.
 *
 * The first entry is the shared agent verbs (`registerAgentTool`) plus the session queue, whose `steer` options are
 * added onto the shared `steer` verb; the two must register together, and the entry names every verb they add.
 */
export const CODEX_REGISTRARS: LazyRegistrar[] = [
    {
        names: [
            "run",
            "start",
            "embed",
            "resume",
            "spawn",
            "steer",
            "read",
            "tail",
            "status",
            "sessions",
            "stop",
            "interrupt",
            "cmux",
            "wait",
            "message",
            "who",
            "active",
            "history",
            "login",
            "warmup",
            "usage",
            "queue",
        ],
        load: async () => {
            const [{ registerAgentTool }, { registerCodexMessageCommands }, { codexSpec }] = await Promise.all([
                import("@app/ai/commands/agent/register"),
                import("./commands/queue"),
                import("./lib/spec"),
            ]);

            return (program: Command) => {
                registerAgentTool(program, codexSpec);
                registerCodexMessageCommands({ program });
            };
        },
    },
    // Codex's own verbs: a persistent daemon with a control channel is the only backend that can
    // offer mid-turn approvals, a turn rollback, a native review, or a raw event log.
    {
        names: ["migrate-home"],
        load: async () => (await import("./commands/migrate-home")).registerMigrateHomeCommand,
    },
    { names: ["desktop"], load: async () => (await import("./commands/desktop")).registerDesktopCommand },
    { names: ["rollback"], load: async () => (await import("./commands/rollback")).registerRollbackCommand },
    { names: ["review"], load: async () => (await import("./commands/review")).registerReviewCommand },
    {
        names: ["reviews", "review-depth"],
        load: async () => (await import("./commands/reviews")).registerReviewsCommands,
    },
    {
        names: ["approve", "deny", "requests", "request"],
        load: async () => (await import("./commands/approve")).registerApprovalCommands,
    },
    { names: ["logs"], load: async () => (await import("./commands/logs")).registerLogsCommand },
    { names: ["models"], load: async () => (await import("./commands/models")).registerModelsCommand },
];
