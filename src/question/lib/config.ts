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
 * What the setting changes, shown by `tools question config`. The texts it describes, and the precedence between this
 * opt-in and the native inbox state, live in ./inbox-guidance.ts.
 */
export const ASK_VIA_QUESTION_TOOL_DESCRIPTION = [
    `Agents learn about ${toolCommand("question")} from the genesis-tools MCP server instructions, the question_post`,
    "tool description and the note every post returns. The first two are read when the server starts, so a change",
    "reaches an agent session started after it.",
    "The native GenesisTools inbox comes first. While its widget runs, agents post decisions, messages and",
    "screenshots there when they need you. While it is installed but not running, they may post and must ALSO",
    "ask you in the chat. Without the native app they hear nothing about the inbox.",
    "This setting decides only whether question_post REPLACES the agent's native question tool for ❓ DECISIONs:",
    `On: agents post every ❓ DECISION with question_post (or ${toolCommand("question ask")}) instead.`,
    "Off (the default): agents ask with their native question tool (for example AskUserQuestion) as usual.",
    "It never removes the chat ask while the widget is not running, and every question is always also written",
    "in the agent's chat reply.",
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
