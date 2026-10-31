import { grokCurrentModel } from "@genesiscz/utils/agent-sessions/readers/grok-model";
import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** The Grok driver's `hooks` part. Grok runs Claude's hooks, and its diff-log entries are extended from its transcript. */
export const grokHooks: HookFacts = {
    diffLogFromTranscript: true,
    transcriptMentions: false,
    modsDrawDiffs: false,
    // `~/.claude/settings.json` says nothing about the model a Grok session runs (2026-09-16: every grok row read "sonnet").
    settingsModel: false,
    currentModel: grokCurrentModel,
    honoursBareGlobQualifier: true,
    // 🛑 Grok cannot show a diff. Observed 2026-09-22 on a real PostToolUse message: it prints the escape sequences as
    // literal text (`[1mUpdated` with the ESC byte eaten), and it cuts the message after about 200 characters, ending
    // `-impo… [+7768 chars]`. So one file header already overflows it, and no `maxMessageChars` or `highlight` setting
    // makes 200 characters a diff. The capture is skipped too, so a Grok session pays nothing for a render it cannot have.
    rendersAnsiDiffs: false,
    turnIsPromptId: false,
    // Grok reads the hook entries of `~/.claude/settings.json` (the same `PreToolUse`, `Notification`, … wiring).
    runsClaudeSettingsHooks: true,
    agentsTalkHint: (tool) =>
        `When agents must talk to each other WHILE they work, read the \`agents-talk\` skill and follow its Grok section: wrap \`${tool("agents login")}\` in the \`monitor\` tool (\`persistent: true\`), which pushes each mail line into the chat, and pass \`--session <id>\` explicitly on every \`${tool("agents")}\` call, because a grok worker's environment may be stripped. An idle grok subagent is not woken by its mail; the parent resumes it with \`spawn_subagent\` \`resume_from\`.`,
    promisesFileTracking: false,
    compactBoundaryRows: false,
    homeBindsAccount: true,
    launchAuthFromAncestor: false,
    journalOmitsProvider: false,
};
