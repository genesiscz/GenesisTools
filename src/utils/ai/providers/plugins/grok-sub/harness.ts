import { isGrok, resolveGrokContext } from "@genesiscz/utils/agent/hosts/grok";
import { grokTurnState } from "@genesiscz/utils/agent-sessions/readers/grok-turn-state";
import { interpreterScriptIndex } from "@genesiscz/utils/harness/interpreter-entry";
import type { HarnessDriver } from "@genesiscz/utils/harness/types";
import { pending, toolOwned, unsupported } from "@genesiscz/utils/harness/types";
import { grokLaunch } from "./harness-launch";
import { grokWorker } from "./harness-worker";

/**
 * The Grok driver: what GenesisTools knows about the harness, part by part. Every part the plan has not moved yet
 * names the phase that moves it and where it lives today (inventory of 2026-10-30 in the plan note). Light on
 * purpose: identity is data and each part is a lazy import, so reading the driver never loads a parser.
 */
export const grokHarness: HarnessDriver<"grok"> = {
    id: "grok",
    identity: {
        label: "Grok",
        binary: "grok",
        plugin: "grok-sub",
        aliases: ["grok-cli"],
        vendor: "xai",
        mark: {
            letter: "G",
            color: { red: 0.75, green: 0.75, blue: 0.78 },
            accent: { red: 0.75, green: 0.6, blue: 0.95 },
            logo: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
        },
    },
    parts: {
        locate: pending("P2", "the grok finders in src/utils/ai/transcripts/resolve.ts and session-paths.ts roots"),
        parse: () => import("./harness-parse").then((m) => m.grokParse),
        turnState: { read: grokTurnState },
        questions: pending(
            "P2",
            "the grok question signals inside src/utils/agent-sessions/readers/grok-turn-state.ts (TurnSnapshot.questionCall)"
        ),
        live: pending(
            "P2",
            "live.ts is provider-neutral since 053da21ed7 (it reads the turnState part and the transcript facts); a live contract of its own only if a harness needs one"
        ),
        launch: grokLaunch,
        transcript: {
            recordsTerminalEvent: true,
            pagesByTurnIndex: false,
            subagentsOnDisk: false,
            // Grok stamps a message in whole seconds.
            timestampResolutionMs: 1000,
            turnIdsEndWithRowUuid: false,
            keepsLiveRegistry: false,
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
            cliEntryIndex: ({ name, command }) =>
                /^(?:node|bun)$/.test(name)
                    ? interpreterScriptIndex(command, (arg) =>
                          /(?:^|[/\\])(?:grok-cli[/\\]dist[/\\]index\.m?js|grok)$/.test(arg)
                      )
                    : /^(?:bash|sh|zsh)$/.test(name)
                      ? 1
                      : 0,
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
        dialog: unsupported(
            "the keys of the Grok ask_user_question dialog were not measured live yet; answer it in the terminal"
        ),
        spend: toolOwned("src/ai-spend/lib/drivers/index.ts", "MonitorDriver lives in the ai-spend tool (P5)"),
        mcp: toolOwned("src/mcp-manager/utils/providers/index.ts", "the MCP config writers live in mcp-manager (P6)"),
        subagents: toolOwned("src/hub/lib/agents/index.ts", "the agents tree lives in the hub tool (P6)"),
    },
};
