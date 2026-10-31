import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** The Codex driver's `hooks` part. Codex's hooks reach shell calls only, and its transcript is not read for diffs. */
export const codexHooks: HookFacts = {
    diffLogFromTranscript: false,
    transcriptMentions: false,
    modsDrawDiffs: false,
    settingsModel: false,
    honoursBareGlobQualifier: true,
    rendersAnsiDiffs: true,
    turnIsPromptId: false,
    // Codex has its own `hooks.json`; Claude's settings never reach it.
    runsClaudeSettingsHooks: false,
};
