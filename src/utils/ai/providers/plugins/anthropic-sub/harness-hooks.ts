import { claudeCurrentModel } from "@genesiscz/utils/agent-sessions/readers/claude-model";
import { claudeSubagentFiles, claudeSubagentsDir } from "@genesiscz/utils/agent-sessions/readers/claude-subagent-path";
import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** The Claude driver's `hooks` part. */
export const claudeHooks: HookFacts = {
    diffLogFromTranscript: true,
    transcriptMentions: true,
    modsDrawDiffs: true,
    settingsModel: true,
    currentModel: claudeCurrentModel,
    subagentTranscript: (sessionTranscript, subagentId) =>
        claudeSubagentFiles(claudeSubagentsDir(sessionTranscript), subagentId).transcript,
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
