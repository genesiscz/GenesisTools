import { isClaude, resolveClaudeContext } from "@genesiscz/utils/agent/hosts/claude";
import type { HarnessDriver } from "@genesiscz/utils/harness/types";
import { pending, toolOwned } from "@genesiscz/utils/harness/types";
import { claudeLaunch } from "./harness-launch";

/**
 * The Claude Code driver: what GenesisTools knows about the harness, part by part. Every part the plan has not moved yet
 * names the phase that moves it and where it lives today (inventory of 2026-10-30 in the plan note). Light on
 * purpose: identity is data and each part is a lazy import, so reading the driver never loads a parser.
 */
export const claudeHarness: HarnessDriver<"claude"> = {
    id: "claude",
    identity: {
        label: "Claude Code",
        binary: "claude",
        plugin: "anthropic-sub",
        aliases: ["claude-code", "claude_code", "cc"],
    },
    parts: {
        locate: pending("P2", "the claude finders in src/utils/ai/transcripts/resolve.ts and session-paths.ts roots"),
        parse: () => import("./harness-parse").then((m) => m.claudeParse),
        turnState: pending("P2", "claudeTurnState and READERS in src/utils/ai/transcripts/turn-state.ts"),
        questions: pending("P2", "the claude question signals inside src/utils/ai/transcripts/turn-state.ts"),
        live: pending("P2", "the claude live tail in src/utils/ai/transcripts/live.ts and activity.ts"),
        launch: claudeLaunch,
        exit: pending("P3", "the claude entry of AGENTS in src/cmux/lib/session-agents.ts"),
        hooks: pending("P4", "the claude entries of HARNESS_HOOK_FACTS and HOOK_INSTALLERS in src/agents"),
        statusline: pending("P4", "the claude statusline host in src/ai/commands/statusline"),
        compaction: pending(
            "P5",
            "compaction reads the history part today (src/utils/ai/compact/sources.ts); a contract of its own only if a harness needs one"
        ),
        host: {
            agent: "claude-code",
            sessionEnvKey: "CLAUDE_CODE_SESSION_ID",
            detects: isClaude,
            resolve: resolveClaudeContext,
        },
        process: {
            runsCli: ({ argv0, name, command }) =>
                name === "claude" ||
                /\/claude\/versions\/[\d.]+$/.test(argv0) ||
                /@anthropic-ai\/claude-code\/cli\.m?js\b/.test(command),
        },
        history: () => import("@genesiscz/utils/agent-sessions/compact-readers").then((m) => m.claudeHistoryReader),
        cmux: toolOwned(
            "src/cmux/lib/session-agents.ts",
            "cmux capture, replay and restore live in the cmux tool (P3)"
        ),
        answer: toolOwned(
            "src/question/lib/decisions/deliver.ts",
            "the delivery ladder lives in the question tool (P6)"
        ),
        worker: toolOwned("src/ai/commands/agent/spec.ts", "the worker drivers live in the agent tools (P6)"),
        spend: toolOwned("src/ai-spend/lib/drivers/index.ts", "MonitorDriver lives in the ai-spend tool (P5)"),
        mcp: toolOwned("src/mcp-manager/utils/providers/index.ts", "the MCP config writers live in mcp-manager (P6)"),
        subagents: toolOwned("src/hub/lib/agents/index.ts", "the agents tree lives in the hub tool (P6)"),
    },
};
