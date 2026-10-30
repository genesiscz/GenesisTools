import type { HookFacts } from "@genesiscz/utils/harness/parts";

/** The Grok driver's `hooks` part. Grok runs Claude's hooks, and its diff-log entries are extended from its transcript. */
export const grokHooks: HookFacts = {
    diffLogFromTranscript: true,
    transcriptMentions: false,
    modsDrawDiffs: false,
    // `~/.claude/settings.json` says nothing about the model a Grok session runs (2026-09-16: every grok row read "sonnet").
    settingsModel: false,
    honoursBareGlobQualifier: true,
    // 🛑 Grok cannot show a diff. Observed 2026-09-22 on a real PostToolUse message: it prints the escape sequences as
    // literal text (`[1mUpdated` with the ESC byte eaten), and it cuts the message after about 200 characters, ending
    // `-impo… [+7768 chars]`. So one file header already overflows it, and no `maxMessageChars` or `highlight` setting
    // makes 200 characters a diff. The capture is skipped too, so a Grok session pays nothing for a render it cannot have.
    rendersAnsiDiffs: false,
    turnIsPromptId: false,
};
