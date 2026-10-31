import { codexCurrentModel } from "@genesiscz/utils/agent-sessions/readers/codex-model";
import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** The Codex driver's `hooks` part. Codex's hooks reach shell calls only, and its transcript is not read for diffs. */
export const codexHooks: HookFacts = {
    diffLogFromTranscript: false,
    transcriptMentions: false,
    modsDrawDiffs: false,
    settingsModel: false,
    currentModel: codexCurrentModel,
    honoursBareGlobQualifier: true,
    rendersAnsiDiffs: true,
    turnIsPromptId: false,
    // Codex has its own `hooks.json`; Claude's settings never reach it.
    runsClaudeSettingsHooks: false,
    agentsTalkHint: () =>
        "Never invoke the `genesis-tools:agents-talk` / `agents-talk` skill: it needs a Monitor tool Codex does not have. For subagent communication use Codex's native collaboration tools (send_message for active peers, followup_task for idle ones).",
    promisesFileTracking: false,
    compactBoundaryRows: false,
    homeBindsAccount: true,
    launchAuthFromAncestor: false,
    journalOmitsProvider: false,
};
