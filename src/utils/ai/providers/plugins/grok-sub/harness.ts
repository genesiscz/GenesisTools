import { isGrok, resolveGrokContext } from "@genesiscz/utils/agent/hosts/grok";
import { grokTurnState } from "@genesiscz/utils/agent-sessions/readers/grok-turn-state";
import type { HarnessDriver } from "@genesiscz/utils/harness/types";
import { pending, toolOwned } from "@genesiscz/utils/harness/types";
import { grokLaunch } from "./harness-launch";
import { grokWorker } from "./harness-worker";

/**
 * The Grok driver: what GenesisTools knows about the harness, part by part. Every part the plan has not moved yet
 * names the phase that moves it and where it lives today (inventory of 2026-10-30 in the plan note). Light on
 * purpose: identity is data and each part is a lazy import, so reading the driver never loads a parser.
 */
export const grokHarness: HarnessDriver<"grok"> = {
    id: "grok",
    identity: { label: "Grok", binary: "grok", plugin: "grok-sub", aliases: ["grok-cli"] },
    parts: {
        locate: pending("P2", "the grok finders in src/utils/ai/transcripts/resolve.ts and session-paths.ts roots"),
        parse: () => import("./harness-parse").then((m) => m.grokParse),
        turnState: { read: grokTurnState },
        questions: pending("P2", "the grok question signals inside src/utils/ai/transcripts/turn-state.ts"),
        live: pending("P2", "the grok live tail in src/utils/ai/transcripts/live.ts and activity.ts"),
        launch: grokLaunch,
        transcript: {
            recordsTerminalEvent: true,
            pagesByTurnIndex: false,
            subagentsOnDisk: false,
            // Grok stamps a message in whole seconds.
            timestampResolutionMs: 1000,
            turnIdsEndWithRowUuid: false,
            // Grok writes its permission prompts to `events.jsonl` in the session folder, never to `updates.jsonl`.
            eventLog: (transcriptPath) =>
                /(^|[/\\])updates\.jsonl$/.test(transcriptPath)
                    ? transcriptPath.replace(/updates\.jsonl$/, "events.jsonl")
                    : null,
        },
        exit: { command: "/exit" },
        hooks: pending("P4", "the grok entries of HARNESS_HOOK_FACTS and HOOK_INSTALLERS in src/agents"),
        statusline: pending("P4", "the grok statusline host in src/ai/commands/statusline"),
        compaction: pending(
            "P5",
            "compaction reads the history part today (src/utils/ai/compact/sources.ts); a contract of its own only if a harness needs one"
        ),
        host: { agent: "grok", sessionEnvKey: "GROK_SESSION_ID", detects: isGrok, resolve: resolveGrokContext },
        process: {
            runsCli: ({ name, command }) =>
                name === "grok" ||
                /^grok-\d+(?:\.\d+)*(?:-[\w-]+)?$/.test(name) ||
                /\bgrok-cli\/dist\/index\.m?js\b/.test(command),
        },
        history: () => import("@genesiscz/utils/agent-sessions/compact-readers").then((m) => m.grokHistoryReader),
        cmux: toolOwned(
            "src/cmux/lib/session-agents.ts",
            "cmux capture, replay and restore live in the cmux tool (P3)"
        ),
        answer: toolOwned(
            "src/question/lib/decisions/deliver.ts",
            "the delivery ladder lives in the question tool (P6)"
        ),
        worker: grokWorker,
        spend: toolOwned("src/ai-spend/lib/drivers/index.ts", "MonitorDriver lives in the ai-spend tool (P5)"),
        mcp: toolOwned("src/mcp-manager/utils/providers/index.ts", "the MCP config writers live in mcp-manager (P6)"),
        subagents: toolOwned("src/hub/lib/agents/index.ts", "the agents tree lives in the hub tool (P6)"),
    },
};
