import { claudeCurrentModel } from "@genesiscz/utils/agent-sessions/readers/claude-model";
import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** The Claude driver's `hooks` part. */
export const claudeHooks: HookFacts = {
    diffLogFromTranscript: true,
    transcriptMentions: true,
    modsDrawDiffs: true,
    settingsModel: true,
    currentModel: claudeCurrentModel,
    // Claude Code sets NO_BARE_GLOB_QUAL, so `(N)` misfires in its shell.
    honoursBareGlobQualifier: false,
    rendersAnsiDiffs: true,
    // Claude's change-log turn is the prompt's `promptId` (`turnPrompts`).
    turnIsPromptId: true,
    runsClaudeSettingsHooks: true,
};
