import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SoundChoice } from "@genesiscz/utils/audio/runner.server";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

export interface QuestionConfig {
    sinks: {
        obsidian: boolean;
        sound: boolean;
        notify: boolean;
        /**
         * Banner for a NEW pending ask form. Separate from `notify`, and on by default:
         * `notify` governs the after-the-fact Q→A firehose, while a pending form means an
         * agent is blocked until it is answered, so silence there is a hang.
         */
        notifyPending?: boolean;
    };
    obsidianPathTemplate: string;
    sound?: SoundChoice; // Phase 2
    soundVolume?: number; // Phase 2, 0..1
    /** See {@link ASK_VIA_QUESTION_TOOL_DESCRIPTION}. Off unless the user opts in. */
    askViaQuestionTool?: boolean;
}

export const ASK_VIA_QUESTION_TOOL_LABEL = `Ask agents to use ${toolCommand("question")} instead of their native question tools?`;

/**
 * What the setting changes, shown by `tools question config`. Keep it in step with the texts it names:
 * `serverInstructions()` in src/genesis-tools-mcp/lib/server.ts, `questionPostDescription()` in
 * src/genesis-tools-mcp/lib/tools/question-post.ts and `agentNote()` in ./agent-note.ts.
 */
export const ASK_VIA_QUESTION_TOOL_DESCRIPTION = [
    `No hook is involved. Agents learn about ${toolCommand("question")} from two texts of the genesis-tools MCP server:`,
    "its server instructions and the question_post tool description. Both are read when the server starts,",
    "so a change reaches an agent session started after it.",
    `On: both texts tell agents to post every ❓ DECISION with question_post (or ${toolCommand("question ask")}).`,
    "Off (the default): both texts tell agents to ask with their native question tool (for example",
    "AskUserQuestion) and in their chat reply. A post still lands in the inbox, and its result reminds",
    "the agent that you have not opted in.",
    "Either way, every post tells the agent that the inbox holds a copy: the question must also be written",
    "in its chat reply.",
].join("\n");

const DEFAULT: QuestionConfig = {
    sinks: { obsidian: true, sound: false, notify: false, notifyPending: true },
    obsidianPathTemplate: "{project}/Questions/{date}.md",
    sound: { kind: "bundled", name: "switch.wav" },
    soundVolume: 0.6,
    askViaQuestionTool: false,
};

export function configPath(): string {
    return env.question.getConfigPath() ?? join(env.tools.getHome(), ".genesis-tools", "question", "config.json");
}

export function loadConfig(path = configPath()): QuestionConfig {
    if (!existsSync(path)) {
        return DEFAULT;
    }

    try {
        return { ...DEFAULT, ...(SafeJSON.parse(readFileSync(path, "utf8")) as Partial<QuestionConfig>) };
    } catch {
        return DEFAULT;
    }
}

export function saveConfig(patch: Partial<QuestionConfig>, path = configPath()): QuestionConfig {
    const current = loadConfig(path);
    // Deep-merge `sinks` so a partial patch like { sinks: { sound: true } }
    // can't silently drop obsidian/notify (t14 — root fix, not per-caller).
    const next: QuestionConfig = {
        ...current,
        ...patch,
        sinks: patch.sinks ? { ...current.sinks, ...patch.sinks } : current.sinks,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SafeJSON.stringify(next, null, 2));
    return next;
}
