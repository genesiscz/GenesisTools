import { isCodex, resolveCodexContext } from "@genesiscz/utils/agent/hosts/codex";
import { codexTurnState } from "@genesiscz/utils/agent-sessions/readers/codex-turn-state";
import type { HarnessDriver } from "@genesiscz/utils/harness/types";
import { pending, toolOwned, unsupported } from "@genesiscz/utils/harness/types";
import { codexLaunch } from "./harness-launch";
import { codexWorker } from "./harness-worker";

/**
 * The Codex driver: what GenesisTools knows about the harness, part by part. Every part the plan has not moved yet
 * names the phase that moves it and where it lives today (inventory of 2026-10-30 in the plan note). Light on
 * purpose: identity is data and each part is a lazy import, so reading the driver never loads a parser.
 */
export const codexHarness: HarnessDriver<"codex"> = {
    id: "codex",
    identity: {
        label: "Codex",
        binary: "codex",
        plugin: "openai-sub",
        aliases: ["codex-cli"],
        mark: { letter: "X", color: { red: 0.55, green: 0.75, blue: 0.95 } },
    },
    parts: {
        locate: pending("P2", "the codex finders in src/utils/ai/transcripts/resolve.ts and session-paths.ts roots"),
        parse: () => import("./harness-parse").then((m) => m.codexParse),
        turnState: { read: codexTurnState },
        questions: pending(
            "P2",
            "the codex question signals inside src/utils/agent-sessions/readers/codex-turn-state.ts (TurnSnapshot.questionCall)"
        ),
        live: pending("P2", "the codex live tail in src/utils/ai/transcripts/live.ts and activity.ts"),
        launch: codexLaunch,
        transcript: {
            recordsTerminalEvent: true,
            pagesByTurnIndex: false,
            subagentsOnDisk: false,
            timestampResolutionMs: 0,
            turnIdsEndWithRowUuid: false,
            keepsLiveRegistry: false,
            // Codex rollouts persist no approval request; only a live app-server client sees one.
            eventLog: () => null,
        },
        exit: { command: "/quit" },
        hooks: pending("P4", "the codex entries of HARNESS_HOOK_FACTS and HOOK_INSTALLERS in src/agents"),
        statusline: pending("P4", "the codex statusline host in src/ai/commands/statusline"),
        compaction: pending(
            "P5",
            "compaction reads the history part today (src/utils/ai/compact/sources.ts); a contract of its own only if a harness needs one"
        ),
        host: { agent: "codex", sessionEnvKey: "CODEX_THREAD_ID", detects: isCodex, resolve: resolveCodexContext },
        process: {
            runsCli: ({ name, command }) =>
                /^codex(?:-[\w-]+)?$/.test(name) || /@openai\/codex\/bin\/codex\.m?js\b/.test(command),
        },
        history: () => import("@genesiscz/utils/agent-sessions/compact-readers").then((m) => m.codexHistoryReader),
        cmux: toolOwned(
            "src/cmux/lib/session-agents.ts",
            "cmux capture, replay and restore live in the cmux tool (P3)"
        ),
        answer: toolOwned(
            "src/question/lib/decisions/deliver.ts",
            "the delivery ladder lives in the question tool (P6)"
        ),
        worker: codexWorker,
        dialog: unsupported(
            "the keys of the Codex request_user_input dialog were not measured live yet; answer it in the terminal"
        ),
        spend: toolOwned("src/ai-spend/lib/drivers/index.ts", "MonitorDriver lives in the ai-spend tool (P5)"),
        mcp: toolOwned("src/mcp-manager/utils/providers/index.ts", "the MCP config writers live in mcp-manager (P6)"),
        subagents: toolOwned("src/hub/lib/agents/index.ts", "the agents tree lives in the hub tool (P6)"),
    },
};
