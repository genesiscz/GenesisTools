import { existsSync, readdirSync } from "node:fs";
import { claudeCompactedSince } from "@genesiscz/utils/agent-sessions/readers/claude-compaction";
import { claudeCurrentModel } from "@genesiscz/utils/agent-sessions/readers/claude-model";
import {
    claudeSubagentCandidates,
    claudeSubagentFiles,
    claudeSubagentsDir,
} from "@genesiscz/utils/agent-sessions/readers/claude-subagent-path";
import { claudeToolCalls } from "@genesiscz/utils/agent-sessions/readers/claude-tool-calls";
import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** A hook loads no logger: a folder it cannot list reads as empty, and the agent's direct path then stands. */
function hookListDir(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * A sub-agent's own transcript. An agent the session started is directly in `subagents/`; an agent of a Workflow tool
 * run is in that run's folder, which is listed only when the direct file is missing.
 */
function claudeSubagentTranscript(sessionTranscript: string, subagentId: string): string {
    const direct = claudeSubagentFiles(claudeSubagentsDir(sessionTranscript), subagentId).transcript;

    if (existsSync(direct)) {
        return direct;
    }

    const inRun = claudeSubagentCandidates(sessionTranscript, subagentId, hookListDir).find((file) =>
        existsSync(file.transcript)
    );
    return inRun?.transcript ?? direct;
}

/** The Claude driver's `hooks` part. */
export const claudeHooks: HookFacts = {
    diffLogFromTranscript: true,
    readToolCalls: claudeToolCalls,
    modsDrawDiffs: true,
    // A code-mode script's shell call is `repl_<uuid>`; a Bash tool call is `toolu_…`. The prefix is not documented.
    // Claude Code 2.1.328 keeps it as one constant, builds every script call's id from it, and tells a script's call
    // apart by that prefix itself (`startsWith`, in its SDK permission requests). No hook field and no transcript row
    // names the REPL call a script's call belongs to (read in that build, 2026-11-25), so the prefix is the one fact.
    // Code mode is `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`, the switch Claude Code reads ("Code Mode (experimental)").
    scriptCalls: {
        prefix: "repl_",
        rowPrefix: "toolu_",
        codeModeOn: (vars) =>
            ["1", "true"].includes(vars.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE?.trim().toLowerCase() ?? ""),
    },
    settingsModel: true,
    currentModel: claudeCurrentModel,
    subagentTranscript: claudeSubagentTranscript,
    // Claude Code sets NO_BARE_GLOB_QUAL, so `(N)` misfires in its shell.
    honoursBareGlobQualifier: false,
    rendersAnsiDiffs: true,
    // Claude's change-log turn is the prompt's `promptId` (`turnPrompts`).
    turnIsPromptId: true,
    runsClaudeSettingsHooks: true,
    agentsTalkHint: () =>
        "Invoke the `genesis-tools:agents-talk` skill first when agents must talk to each other WHILE they work: a `gt:handoff-to` swarm, or an agent team whose lead may need to steer a teammate in the middle of its task (team mail to a busy teammate waits until its turn ends). Ordinary subagents that report back when finished need nothing from it. The Skill tool only accepts that full id — `gt:agents-talk` is not a valid skill name.",
    promisesFileTracking: true,
    compactBoundaryRows: true,
    compactedSince: claudeCompactedSince,
    homeBindsAccount: false,
    launchAuthFromAncestor: true,
    journalOmitsProvider: true,
    payload: {
        spelling: "snake_case",
        transcriptName: /[/\\]projects[/\\][^/\\]+[/\\][^/\\]+\.jsonl$/,
        nullTranscript: false,
        // Claude names its model on SessionStart only (code.claude.com/docs/en/hooks).
        modelEvents: ["SessionStart"],
        // The prompt that started the turn (`prompt_id`, the transcript's `promptId`): the key of its change rows.
        turnIdField: "prompt_id",
        subagentIdField: "agent_id",
    },
};
