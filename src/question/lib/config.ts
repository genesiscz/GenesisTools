import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SoundChoice } from "@genesiscz/utils/audio/runner.server";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, isJsonObject } from "@genesiscz/utils/storage/atomic-file";

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

/**
 * The config on disk, for a caller that will write it back. Only a missing file means defaults: a file that
 * exists but cannot be read or does not parse throws, so a save never replaces the user's settings with defaults.
 */
function readConfigForUpdate(path: string): QuestionConfig {
    if (!existsSync(path)) {
        return DEFAULT;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`Invalid question config at ${path}: it cannot be read or does not parse, left untouched`, {
            cause: error,
        });
    }

    if (!isJsonObject(parsed)) {
        throw new Error(`Invalid question config at ${path}: expected a JSON object, left untouched`);
    }

    return { ...DEFAULT, ...(parsed as Partial<QuestionConfig>) };
}

export function loadConfig(path = configPath()): QuestionConfig {
    try {
        return readConfigForUpdate(path);
    } catch (err) {
        logger.warn({ err, path }, "question config is unreadable; using defaults until it is fixed");
        return DEFAULT;
    }
}

export function saveConfig(patch: Partial<QuestionConfig>, path = configPath()): QuestionConfig {
    const current = readConfigForUpdate(path);
    // Deep-merge `sinks` so a partial patch like { sinks: { sound: true } }
    // can't silently drop obsidian/notify (t14 — root fix, not per-caller).
    const next: QuestionConfig = {
        ...current,
        ...patch,
        sinks: patch.sinks ? { ...current.sinks, ...patch.sinks } : current.sinks,
    };
    atomicWriteFileSync(path, SafeJSON.stringify(next, null, 2));
    return next;
}
