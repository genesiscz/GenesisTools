import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";

/**
 * One entry per `tools question` command file, in the order `--help` lists them. Registering all of them eagerly cost
 * every call about 220 ms of CPU for imports (2026-10-27): the inbox tree alone pulls the session listing, delivery
 * and codex spawn modules. A name missing here only falls back to loading every tree, never to a missing command.
 */
export const QUESTION_REGISTRARS: LazyRegistrar[] = [
    {
        names: ["ask", "post", "wait", "poll", "answer", "cancel"],
        load: async () => (await import("./commands/ask")).registerAskCommand,
    },
    {
        names: ["list", "update", "chat-answers", "repair", "draft", "send", "stale"],
        load: async () => (await import("./commands/decisions")).registerDecisionCommands,
    },
    { names: ["show"], load: async () => (await import("./commands/show")).registerShowCommand },
    { names: ["tokens"], load: async () => (await import("./commands/tokens")).registerTokensCommand },
    { names: ["inbox"], load: async () => (await import("./commands/inbox")).registerInboxCommand },
    { names: ["record"], load: async () => (await import("./commands/record")).registerRecordCommand },
    { names: ["message"], load: async () => (await import("./commands/message")).registerMessageCommand },
    { names: ["log"], load: async () => (await import("./commands/log")).registerLogCommand },
    { names: ["tail", "answers"], load: async () => (await import("./commands/tail")).registerTailCommand },
    { names: ["config"], load: async () => (await import("./commands/config")).registerConfigCommand },
    {
        names: ["transcript-rows"],
        load: async () => (await import("./commands/transcript-rows")).registerTranscriptRowsCommand,
    },
];
